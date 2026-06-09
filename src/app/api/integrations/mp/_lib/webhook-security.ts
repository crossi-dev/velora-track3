// MP webhook security helpers — IP ban tracker + HMAC signature verification.
// Extracted from webhook/route.ts to stay under the 300-line file-size contract.

import { createHmac, timingSafeEqual } from "crypto";
import type { NextRequest } from "next/server";
import { cloudLog } from "@/lib/cloud-logger";
import { prisma } from "@/lib/prisma";
import { isMpTrustedIp, memBanRecord, memBanCheck } from "./webhook-security-ip";

// ── Distributed IP ban — DB-backed, multi-instance safe ──────────────────────
// Replaces the in-memory Map that was per-Cloud-Run-instance only.
// An attacker distributing probes across N instances would never hit the
// threshold on any single instance. Storing counters in Postgres makes the
// limit global across the entire fleet.
//
// Table: WebhookSecurityIncident (migration 20260525600000)
// Upsert key: (ipAddress, eventType). Indexed for fast point lookups.
// TTL: expiresAt = now + 1 day. Swept by audit-cleanup cron daily.
//
// BAN_DURATION_MS raised from 5 min → 1 hour: MP's webhook retry window is
// 72 hours (docs.mercadopago.com.ar/developers/es/docs/notifications/webhooks
// #bookmark_retry_notifications 2026). A 5-min ban expires before MP's first
// retry, giving an attacker an effectively unlimited probe window with brief
// pauses. 1 hour forces a meaningful back-off.
const MISMATCH_THRESHOLD = 3;
const BAN_DURATION_MS = 60 * 60_000; // 1 hour (raised from 5 min — MP retry window is 72 h)
const INCIDENT_TTL_MS = 24 * 60 * 60_000;
const EVENT_TYPE = "mp_tenant_mismatch";

export { getClientIp } from "@/lib/client-ip";

/**
 * Returns true if the IP is currently banned (blockedUntil > now).
 * Uses a DB point-lookup — O(1) via the unique index on (ipAddress, eventType).
 *
 * Short-circuits on known MP egress CIDRs (MP_TRUSTED_CIDRS env var) — MP
 * infrastructure IPs must never be blocked even under a flood from a customer.
 *
 * Falls back to the in-memory LRU ban counter when the DB is unreachable so the
 * system retains ban capability under a sustained DB outage + flood scenario.
 * Ref: webhook-security-ip.ts (memBanCheck / isMpTrustedIp).
 */
export async function checkIpBan(ip: string): Promise<boolean> {
  // Trusted MP infrastructure — never ban.
  if (isMpTrustedIp(ip)) return false;
  try {
    const row = await prisma.webhookSecurityIncident.findUnique({
      where: { ipAddress_eventType: { ipAddress: ip, eventType: EVENT_TYPE } },
      select: { blockedUntil: true },
    });
    if (!row?.blockedUntil) return false;
    return row.blockedUntil > new Date();
  } catch {
    // DB unavailable — fall back to in-memory LRU counter (per-instance, non-fleet-wide
    // but better than fully fail-open under a DB outage + flood attack).
    return memBanCheck(ip, Date.now());
  }
}

/**
 * Records one mismatch probe for the given IP.
 * Upserts the counter row; once count >= MISMATCH_THRESHOLD, writes blockedUntil.
 * Fire-and-forget — callers do not await this (matches prior void behavior).
 */
export function recordMismatch(ip: string): void {
  void _recordMismatchAsync(ip);
}

async function _recordMismatchAsync(ip: string): Promise<void> {
  // Always update the in-memory LRU counter first — works even during DB outages.
  memBanRecord(ip, Date.now(), MISMATCH_THRESHOLD, BAN_DURATION_MS);
  try {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + INCIDENT_TTL_MS);

    // Upsert: increment count and refresh TTL. blockedUntil is set in a
    // second step only when threshold is first crossed (avoids a read-modify
    // race — the conditional update is idempotent if already set).
    const row = await prisma.webhookSecurityIncident.upsert({
      where: { ipAddress_eventType: { ipAddress: ip, eventType: EVENT_TYPE } },
      create: {
        ipAddress: ip,
        eventType: EVENT_TYPE,
        count: 1,
        expiresAt,
      },
      update: {
        count: { increment: 1 },
        expiresAt,
      },
      select: { count: true, blockedUntil: true },
    });

    // Set blockedUntil the first time threshold is crossed.
    if (row.count >= MISMATCH_THRESHOLD && !row.blockedUntil) {
      const blockedUntil = new Date(now.getTime() + BAN_DURATION_MS);
      await prisma.webhookSecurityIncident.update({
        where: { ipAddress_eventType: { ipAddress: ip, eventType: EVENT_TYPE } },
        data: { blockedUntil },
      });
      cloudLog({
        severity: "WARNING",
        component: "System",
        action: "MP_WEBHOOK_IP_BANNED",
        a2a_transfer: false,
        message: `IP ${ip} banned for ${BAN_DURATION_MS / 1000}s after ${row.count} tenant mismatch attempts`,
        data: { ip, count: row.count },
      });
    }
  } catch (err) {
    // Non-fatal: log and continue. A missed counter increment is acceptable;
    // the alternative (hard-failing the webhook handler) is worse.
    cloudLog({
      severity: "ERROR",
      component: "System",
      action: "MP_WEBHOOK_MISMATCH_RECORD_FAILED",
      a2a_transfer: false,
      message: `Failed to record mismatch for IP ${ip}`,
      data: { ip, error: String(err) },
    });
  }
}

// ── HMAC-SHA256 signature verification ───────────────────────────────────────
// Spec: https://www.mercadopago.com.ar/developers/es/docs/notifications/webhooks
// Template: "id:{resourceId};request-id:{x-request-id};ts:{ts};"
//
// MP uses the same x-signature scheme for both "payment" and "merchant_order"
// topics — the only difference is which resource ID goes into the template.
// Pass paymentId for "payment" topic, merchantOrderId for "merchant_order".
export function verifyMpSignature(
  req: NextRequest,
  paymentId: string,
  merchantOrderId?: string,
): boolean {
  const secret = (process.env.MP_WEBHOOK_SECRET ?? "").trim();
  if (!secret) {
    cloudLog({
      severity: "ERROR",
      component: "System",
      action: "MP_WEBHOOK_SECRET_MISSING",
      a2a_transfer: false,
      message: "MP_WEBHOOK_SECRET not set — rejecting webhook (fail-closed). Configure MP_WEBHOOK_SECRET in Secret Manager.",
    });
    // Fail-closed: without a secret we cannot verify the signature, so we
    // must reject rather than allow — an open-secret environment would let
    // any attacker forge a payment confirmation.
    return false;
  }

  const xSignature = req.headers.get("x-signature") ?? "";
  const xRequestId = req.headers.get("x-request-id") ?? "";
  if (!xSignature || !xRequestId) {
    cloudLog({
      severity: "WARNING",
      component: "System",
      action: "MP_WEBHOOK_MISSING_SIG_HEADERS",
      a2a_transfer: false,
      message: "webhook topic missing x-signature or x-request-id headers",
    });
    return false;
  }

  const tsMatch = xSignature.match(/ts=(\d+)/);
  const v1Match = xSignature.match(/v1=([0-9a-f]+)/);
  if (!tsMatch || !v1Match) return false;

  const ts = tsMatch[1];
  const tsMs = Number(ts) * 1000;
  const nowMs = Date.now();
  if (Number.isNaN(tsMs) || Math.abs(nowMs - tsMs) > 300_000) {
    cloudLog({
      severity: "WARNING",
      component: "System",
      action: "MP_WEBHOOK_REPLAY_REJECTED",
      a2a_transfer: false,
      message: "MP webhook rejected — timestamp outside 5-minute window",
      data: { ts, nowMs, deltaMs: nowMs - tsMs },
    });
    return false;
  }

  // Use merchantOrderId when provided (merchant_order topic), otherwise paymentId.
  // REG-T3-1: reject when both are empty — the HMAC template collapses to
  // "id:;request-id:…;ts:…;" which a forger can precompute once the pattern is known.
  const resourceId = merchantOrderId ?? paymentId;
  if (!resourceId) {
    cloudLog({
      severity: "WARNING",
      component: "System",
      action: "MP_WEBHOOK_EMPTY_RESOURCE_ID",
      a2a_transfer: false,
      message: "MP webhook rejected — both merchantOrderId and paymentId are empty",
    });
    return false;
  }
  const providedDigest = v1Match[1];
  const template = `id:${resourceId};request-id:${xRequestId};ts:${ts};`;
  const expected = createHmac("sha256", secret).update(template).digest("hex");

  // Constant-time comparison — prevent timing side-channel attacks.
  // timingSafeEqual throws if buffers have different lengths, so guard first.
  if (expected.length !== providedDigest.length) return false;
  // Buffer.from(x, "hex") silently truncates on malformed input, which causes
  // timingSafeEqual to throw a buffer-length mismatch. Wrap in try/catch so a
  // malformed digest from an attacker returns false instead of propagating.
  try {
    return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(providedDigest, "hex"));
  } catch {
    return false;
  }
}
