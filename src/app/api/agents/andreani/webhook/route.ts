import { NextRequest, NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { cloudLog, runWithTraceContext } from "@/lib/cloud-logger";
import { checkRateLimit } from "@/app/api/_lib/route-helpers";
import { getClientIp } from "@/lib/client-ip";
import type { TrackingEvent } from "../_lib/types";

// Andreani webhook receiver — handles tracking state change events.
//
// Auth: HMAC-SHA256 signature via ANDREANI_WEBHOOK_SECRET (optional; graceful if absent).
// On every event: update AndreaniShipment.status + append to events array.
//
// POST /api/agents/andreani/webhook
// Allowlisted in middleware: no session required (Andreani-originated request).

// Module-level startup check: emit a single WARNING at cold-start when the secret
// is missing so the operator sees it in Cloud Logging immediately, not only when
// the first webhook arrives (which may be hours later in production).
(function checkWebhookSecretAtStartup() {
  if (!(process.env.ANDREANI_WEBHOOK_SECRET ?? "").trim()) {
    cloudLog({
      severity: "WARNING",
      component: "A2A",
      action: "ANDREANI_WEBHOOK_SECRET_MISSING_STARTUP",
      a2a_transfer: false,
      message:
        "ANDREANI_WEBHOOK_SECRET is not set. " +
        "Andreani tracking webhooks will reject ALL incoming calls (fail-closed). " +
        "Set ANDREANI_WEBHOOK_SECRET in Secret Manager to enable webhook signature verification.",
      data: {},
    });
  }
})();

// Body size guard: 64 KB — matches the MP webhook limit. Andreani payloads are
// far smaller in practice; this prevents OOM from malicious oversized bodies.
const ANDREANI_WEBHOOK_MAX_BODY_BYTES = 64 * 1024;

const OK = () => NextResponse.json({ ok: true }, { status: 200 });
const FAIL = (msg: string) => NextResponse.json({ error: msg }, { status: 400 });

// Andreani webhook payload (sandbox shape — may vary in production).
interface AndreaniWebhookPayload {
  nroAndreani?: string;
  numeroEnvio?: string;
  estado?: string;
  fecha?: string;
  descripcion?: string;
  sucursal?: string;
}

async function handlePost(req: NextRequest): Promise<NextResponse> {
  // Rate-limit before any body read — 60 requests/min per IP mirrors the
  // MODO webhook limit and is generous for legitimate Andreani traffic.
  // Returns 200 (not 429) to suppress Andreani's retry loop on flood events.
  const ip = getClientIp(req.headers);
  const rateLimited = checkRateLimit(req, "andreani-webhook", 60, 60);
  if (rateLimited) {
    cloudLog({
      severity: "WARNING",
      component: "A2A",
      action: "ANDREANI_WEBHOOK_RATE_LIMITED",
      a2a_transfer: false,
      message: "Andreani webhook rate-limit hit — returning 200 to suppress retries",
      data: { ip },
    });
    return OK();
  }

  // Body size guard — read raw text, reject oversized requests before HMAC.
  // Andreani sends the signature over the raw body; req.text() is the only
  // way to access it without consuming the stream early.
  const rawBody = await req.text();
  if (Buffer.byteLength(rawBody, "utf8") > ANDREANI_WEBHOOK_MAX_BODY_BYTES) {
    cloudLog({
      severity: "WARNING",
      component: "A2A",
      action: "ANDREANI_WEBHOOK_BODY_TOO_LARGE",
      a2a_transfer: false,
      message: `Andreani webhook body exceeds ${ANDREANI_WEBHOOK_MAX_BODY_BYTES} bytes — rejected`,
      data: { byteLength: Buffer.byteLength(rawBody, "utf8"), ip },
    });
    return NextResponse.json({ ok: false, error: "body_too_large" }, { status: 413 });
  }

  // HMAC validation — skip if secret not configured (dev/test only).
  if (!verifyAndreaniSignature(req, rawBody)) {
    cloudLog({ severity: "WARNING", component: "A2A", action: "ANDREANI_WEBHOOK_SIG_INVALID",
      a2a_transfer: false, message: "Andreani webhook signature invalid", data: {} });
    return FAIL("signature_invalid");
  }

  let payload: AndreaniWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as AndreaniWebhookPayload;
  } catch {
    return FAIL("invalid_json");
  }

  const trackingNumber = payload.nroAndreani ?? payload.numeroEnvio ?? null;
  if (!trackingNumber) {
    return OK(); // ack — malformed, avoid Andreani retries
  }

  const newStatus = normalizeStatus(payload.estado ?? "");
  const newEvent: TrackingEvent = {
    timestamp: payload.fecha ?? new Date().toISOString(),
    status: payload.estado ?? "",
    description: payload.descripcion ?? payload.estado ?? "",
    location: payload.sucursal,
  };

  cloudLog({ severity: "INFO", component: "A2A", action: "ANDREANI_WEBHOOK_RECEIVED",
    a2a_transfer: false, message: `Andreani webhook trackingNumber=${trackingNumber} status=${newStatus}`,
    data: { trackingNumber, newStatus } });

  const shipment = await prisma.andreaniShipment.findUnique({
    where: { trackingNumber },
    select: { businessId: true }, // events re-read atomically inside the dedup transaction
  });

  if (!shipment) {
    // Not our shipment — ack and drop.
    return OK();
  }

  // Defense-in-depth: confirm the shipment's business still exists in our system.
  // trackingNumber is globally unique so the findUnique is valid, but this check
  // ensures the owning business wasn't deleted after HMAC verification passed.
  const businessExists = await prisma.business.findUnique({
    where: { id: shipment.businessId },
    select: { id: true },
  });
  if (!businessExists) {
    cloudLog({ severity: "WARNING", component: "A2A", action: "ANDREANI_WEBHOOK_ORPHAN_SHIPMENT",
      a2a_transfer: false,
      message: `Andreani webhook: shipment ${trackingNumber} belongs to deleted business ${shipment.businessId}`,
      data: { trackingNumber, businessId: shipment.businessId } });
    return OK(); // ack to prevent Andreani retries on a permanently invalid shipment
  }

  // Dedup + update in a SERIALIZABLE transaction so parallel Andreani retries
  // cannot both pass the duplicate check and double-write the same event.
  // READ COMMITTED (Prisma default) is not sufficient: two concurrent transactions
  // both read the events array before either commits and both find no duplicate.
  // SERIALIZABLE causes Postgres to detect the write-write conflict and abort one
  // of the concurrent transactions with a serialization error, which propagates as
  // an exception and returns 500 — Andreani will retry and the second attempt will
  // see the already-committed event and correctly skip it.
  // pgbouncer transaction mode is compatible with SERIALIZABLE (each statement is
  // proxied on the same connection within the Prisma-managed transaction block).
  let appended = false;
  let finalEventCount = 0;

  await prisma.$transaction(async (tx) => {
    const fresh = await tx.andreaniShipment.findUnique({
      where: { trackingNumber },
      select: { businessId: true, events: true },
    });
    if (!fresh) return; // shipment disappeared between the outer read and now — no log needed, ack'd above

    const freshEvents = Array.isArray(fresh.events)
      ? (fresh.events as unknown as TrackingEvent[])
      : [];

    const isDuplicate = freshEvents.some(
      (e) => e.timestamp === newEvent.timestamp && e.status === newEvent.status,
    );
    if (isDuplicate) {
      cloudLog({ severity: "INFO", component: "A2A", action: "ANDREANI_WEBHOOK_DUPLICATE_EVENT",
        a2a_transfer: false,
        message: `Duplicate event skipped for ${trackingNumber} (ts=${newEvent.timestamp} status=${newEvent.status})`,
        data: { trackingNumber, timestamp: newEvent.timestamp, status: newEvent.status } });
      return; // appended stays false
    }

    const updatedEvents: TrackingEvent[] = [...freshEvents, newEvent];
    finalEventCount = updatedEvents.length;

    // C-2: scope update to businessId so a leaked HMAC secret cannot mutate
    // another tenant's shipment row via a crafted trackingNumber.
    await tx.andreaniShipment.update({
      where: { trackingNumber, businessId: fresh.businessId },
      data: { status: newStatus, events: updatedEvents as unknown as Prisma.InputJsonValue },
    });
    appended = true;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

  if (!appended) return OK(); // duplicate or disappeared

  cloudLog({ severity: "INFO", component: "A2A", action: "ANDREANI_SHIPMENT_UPDATED",
    a2a_transfer: false, message: `Shipment ${trackingNumber} → ${newStatus}`,
    data: { trackingNumber, newStatus, totalEvents: finalEventCount } });

  return OK();
}

export function POST(req: NextRequest): Promise<NextResponse> {
  return runWithTraceContext(req.headers, () => handlePost(req));
}

// Map Andreani API status strings to our internal status vocabulary.
function normalizeStatus(andreaniStatus: string): string {
  const s = andreaniStatus.toLowerCase();
  if (s.includes("entregado") || s.includes("delivered")) return "delivered";
  if (s.includes("transit") || s.includes("tránsito") || s.includes("despacho")) return "in_transit";
  if (s.includes("fallo") || s.includes("rechazado") || s.includes("devuelto")) return "failed";
  if (s.includes("creado") || s.includes("ingresado")) return "created";
  return "in_transit"; // safe default for unknown intermediate states
}

// Andreani sandbox uses HMAC-SHA256 on the raw body, sent as X-Andreani-Signature.
//
// Expected encoding: lowercase hex (64 chars), optionally prefixed with "sha256=".
// Andreani's public API docs do not specify the encoding; no official 2026 source
// confirms base64. The sandbox consistently sends hex. We try hex first and fall
// back to base64 (without padding, as common in HMAC-over-webhook patterns) so
// that a future encoding change on Andreani's side is self-correcting rather than
// silently rejecting all webhooks. Whichever encoding matches is logged at INFO
// level so ops can detect format drift early.
//
// Security properties preserved:
//   - timingSafeEqual prevents timing-based signature forgery.
//   - Length validation before Buffer.from prevents a silent wrong-length buffer
//     that would pass timingSafeEqual against a zero-padded expected buffer.
//   - Fail-closed on missing secret (no "allow all" fallback).

// SHA-256 HMAC produces 32 bytes → 64 hex chars or 44 base64 chars (with padding).
const HMAC_SHA256_HEX_LENGTH = 64;
const HMAC_SHA256_BASE64_LENGTH = 44; // ceil(32/3)*4 = 44 with standard padding

function verifyAndreaniSignature(req: NextRequest, body: string): boolean {
  const secret = (process.env.ANDREANI_WEBHOOK_SECRET ?? "").trim();
  if (!secret) {
    // Fail-closed: missing secret means we cannot verify authenticity.
    cloudLog({ severity: "ERROR", component: "A2A", action: "ANDREANI_WEBHOOK_SECRET_MISSING",
      a2a_transfer: false, message: "ANDREANI_WEBHOOK_SECRET not set — rejecting all webhook calls", data: {} });
    return false;
  }

  const signature = req.headers.get("x-andreani-signature") ?? "";
  if (!signature) return false;

  const provided = signature.replace(/^sha256=/, "");

  const expectedBytes = createHmac("sha256", secret).update(body).digest();
  // expectedBytes is always 32 bytes; derive both representations once.
  const expectedHex = expectedBytes.toString("hex");
  const expectedBase64 = expectedBytes.toString("base64");

  // Try hex first (canonical sandbox format).
  if (provided.length === HMAC_SHA256_HEX_LENGTH) {
    try {
      const result = timingSafeEqual(Buffer.from(expectedHex, "hex"), Buffer.from(provided, "hex"));
      if (result) {
        cloudLog({ severity: "INFO", component: "A2A", action: "ANDREANI_WEBHOOK_SIG_FORMAT",
          a2a_transfer: false, message: "Andreani signature verified — format: hex", data: {} });
      }
      return result;
    } catch (err: unknown) {
      cloudLog({ severity: "ERROR", component: "A2A", action: "ANDREANI_WEBHOOK_TIMING_SAFE_EQUAL_ERROR",
        a2a_transfer: false, message: "timingSafeEqual (hex) threw unexpectedly — rejecting Andreani webhook",
        data: { error: err instanceof Error ? err.message : String(err) } });
      return false;
    }
  }

  // Try base64 fallback (in case Andreani switches encoding in production).
  if (provided.length === HMAC_SHA256_BASE64_LENGTH) {
    try {
      const result = timingSafeEqual(
        Buffer.from(expectedBase64, "base64"),
        Buffer.from(provided, "base64"),
      );
      if (result) {
        cloudLog({ severity: "INFO", component: "A2A", action: "ANDREANI_WEBHOOK_SIG_FORMAT",
          a2a_transfer: false, message: "Andreani signature verified — format: base64 (non-standard; investigate)", data: {} });
      }
      return result;
    } catch (err: unknown) {
      cloudLog({ severity: "ERROR", component: "A2A", action: "ANDREANI_WEBHOOK_TIMING_SAFE_EQUAL_ERROR",
        a2a_transfer: false, message: "timingSafeEqual (base64) threw unexpectedly — rejecting Andreani webhook",
        data: { error: err instanceof Error ? err.message : String(err) } });
      return false;
    }
  }

  // Neither hex (64) nor base64 (44) length — reject before any comparison.
  cloudLog({ severity: "WARNING", component: "A2A", action: "ANDREANI_WEBHOOK_SIG_INVALID_LENGTH",
    a2a_transfer: false,
    message: `Andreani signature has unexpected length ${provided.length} (expected ${HMAC_SHA256_HEX_LENGTH} hex or ${HMAC_SHA256_BASE64_LENGTH} base64) — rejecting`,
    data: { providedLength: provided.length } });
  return false;
}
