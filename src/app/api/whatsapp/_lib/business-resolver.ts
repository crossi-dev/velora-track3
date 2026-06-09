// business-resolver.ts — Resolves the businessId for an inbound WhatsApp webhook.
//
// Two paths:
//   1. Meta Cloud API: lookup WabaConnection by phoneNumberId (multi-tenant).
//   2. Twilio: single-business bridge via STEP5_BRIDGE_BUSINESS_ID env var.
//
// Returns null (with WARNING log) when no match is found. Callers MUST treat
// null as "skip dispatch" — the webhook always returns 200 to Meta/Twilio.
//
// Sources:
//   Meta Cloud API webhook: https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks
//   Twilio WhatsApp inbound: https://www.twilio.com/docs/whatsapp/api/incoming-messages
//   A2A Protocol v1.0: https://a2a-protocol.org/latest/specification/

import "server-only";

import { cloudLog } from "@/lib/cloud-logger";
import { prisma } from "@/lib/prisma";

// ── Types ─────────────────────────────────────────────────────────────────────

export type ResolvedBusiness = {
  businessId: string;
  /** Which resolution path was used — for logging and observability. */
  via: "phone_number_id" | "twilio_bridge";
};

export type ResolveArgs = {
  provider: "meta" | "twilio";
  /** Meta: payload.entry[].changes[].value.metadata.phone_number_id */
  toPhoneNumberId?: string | null;
  /** Twilio: the "To" form field (e.g. "whatsapp:+14155238886") */
  toPhoneE164?: string | null;
};

// ── Resolution ────────────────────────────────────────────────────────────────

/**
 * Resolve which business should handle an inbound WhatsApp message.
 *
 * Resolution order:
 * 1. Meta + phoneNumberId → WabaConnection DB lookup (full multi-tenant).
 * 2. Twilio + STEP5_BRIDGE_BUSINESS_ID set → single-business bridge.
 * 3. Otherwise → null (skip dispatch, log WARNING).
 *
 * @returns ResolvedBusiness or null if no match.
 */
export async function resolveBusinessForInbound(
  args: ResolveArgs,
): Promise<ResolvedBusiness | null> {
  const { provider, toPhoneNumberId, toPhoneE164 } = args;

  // ── Path 1: Meta Cloud API — lookup by phoneNumberId ──────────────────────
  if (provider === "meta" && toPhoneNumberId) {
    return resolveByPhoneNumberId(toPhoneNumberId);
  }

  // ── Path 2: Twilio — single-business bridge ───────────────────────────────
  if (provider === "twilio") {
    return resolveTwilioBridge(toPhoneE164 ?? null);
  }

  cloudLog({
    severity: "WARNING",
    component: "WhatsApp",
    action: "WEBHOOK_RESOLVE_SKIP",
    a2a_transfer: false,
    message: "Inbound webhook has no resolvable business — no phoneNumberId and not Twilio",
    data: { provider, toPhoneNumberId: toPhoneNumberId ?? null },
  });

  return null;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

async function resolveByPhoneNumberId(
  phoneNumberId: string,
): Promise<ResolvedBusiness | null> {
  try {
    // WabaConnection has @@index([phoneNumberId]) — point lookup.
    // Uses `any` cast because Prisma client regeneration is blocked in the
    // worktree due to shared node_modules DLL lock (same pattern as services-status/route.ts).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Prisma client regen blocked in worktree (see business-capabilities.ts:59)
    const conn = await (prisma as any).wabaConnection.findFirst({
      where: { phoneNumberId },
      select: { businessId: true },
    });

    if (!conn) {
      cloudLog({
        severity: "WARNING",
        component: "WhatsApp",
        action: "WEBHOOK_RESOLVE_NO_WABA",
        a2a_transfer: false,
        message: `No WabaConnection found for phoneNumberId=${phoneNumberId}`,
        data: { phoneNumberId },
      });
      return null;
    }

    return { businessId: conn.businessId as string, via: "phone_number_id" };
  } catch (err) {
    cloudLog({
      severity: "ERROR",
      component: "WhatsApp",
      action: "WEBHOOK_RESOLVE_DB_ERROR",
      a2a_transfer: false,
      message: `WabaConnection lookup failed: ${err instanceof Error ? err.message : String(err)}`,
      data: { phoneNumberId },
    });
    return null;
  }
}

function resolveTwilioBridge(
  toPhoneE164: string | null,
): ResolvedBusiness | null {
  const bridgeBusinessId = process.env.STEP5_BRIDGE_BUSINESS_ID?.trim();

  if (!bridgeBusinessId) {
    cloudLog({
      severity: "WARNING",
      component: "WhatsApp",
      action: "WEBHOOK_RESOLVE_TWILIO_NO_BRIDGE",
      a2a_transfer: false,
      message:
        "STEP5_BRIDGE_BUSINESS_ID is not set — Twilio inbound messages will not be dispatched. " +
        "Set this env var in Cloud Run to the target businessId.",
      data: { toPhoneE164 },
    });
    return null;
  }

  return { businessId: bridgeBusinessId, via: "twilio_bridge" };
}
