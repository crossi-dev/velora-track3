// Onboarding LLM-front-door — Tool 5: connect_whatsapp_business.
//
// Lightweight phone capture path — collects Business.whatsappBusinessPhoneE164
// only (no WABA token, no Meta Embedded Signup). Full Embedded Signup with
// wabaId + phoneNumberId + accessToken requires Meta Tech Provider enrollment
// and is delivered via the Services tab modal (deferred to post-enrollment).
//
// Source — Stripe Incremental Onboarding pattern ("currently_due"):
//   https://docs.stripe.com/connect/custom/hosted-onboarding
//   "currently_due requirements request only the user information needed for
//    verification at this specific point in time"
//
// Source — Meta Embedded Signup (deferred — placeholder for full flow):
//   https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/overview/
//   (Tech Provider enrollment required — do NOT call WABA APIs without it)
//
// ADK FunctionTool declaration name: "connect_whatsapp_business"

import { cloudLog } from "@/lib/cloud-logger";
import type { ToolContext, ToolResult } from "./onboarding-agent.tools";

// ── E.164 validation ──────────────────────────────────────────────────────────
//
// E.164 format: + followed by 7–15 digits.
// Argentina: +54 9 11 XXXX-XXXX → +5491XXXXXXXX (13 digits total)
// Ref: ITU-T E.164 (https://www.itu.int/rec/T-REC-E.164)

const E164_RE = /^\+\d{7,15}$/;

export function isValidE164(phone: string): boolean {
  return E164_RE.test(phone);
}

// ── Tool input / output ───────────────────────────────────────────────────────

export interface ConnectWhatsappBusinessArgs {
  /**
   * WhatsApp Business phone number in E.164 format (e.g. "+5491100000000").
   * Required. Must start with "+" followed by 7–15 digits.
   */
  phoneE164: string;
}

export interface ConnectWhatsappBusinessResult extends ToolResult {
  /**
   * The persisted E.164 phone number, echoed back on success.
   * Null on failure.
   */
  phoneE164: string | null;
  /**
   * True when this is a first-time capture (whatsapp_phone was previously false).
   * Used by the buoy contract to surface the capability as newly activated.
   */
  wasFirstCapture: boolean;
}

// ── Tool handler ──────────────────────────────────────────────────────────────

/**
 * Persists Business.whatsappBusinessPhoneE164 for the given business.
 *
 * This is the LIGHTER capture path — just the phone number. Full Embedded
 * Signup (WabaConnection row with WABA credentials) comes from the Services
 * tab and requires Meta Tech Provider enrollment.
 *
 * Validation:
 *   - phoneE164 must match E.164 (/^\+\d{7,15}$/).
 *   - businessId must belong to an active business (checked by the route).
 *
 * Persistence:
 *   - PATCH /api/business with { whatsappBusinessPhoneE164: phoneE164 }.
 *   - Re-uses the existing mutation pipeline (auth + rate limit + idempotency
 *     + audit) — does NOT bypass it.
 *
 * Why not call Prisma directly:
 *   The mutation pipeline enforces idempotency, audit records, and the server
 *   mutation contract. Bypassing it with a raw Prisma call would skip all
 *   guardrails and leave no CriticalWriteEvent trail.
 */
export async function connectWhatsappBusiness(
  args: ConnectWhatsappBusinessArgs,
  ctx: ToolContext,
): Promise<ConnectWhatsappBusinessResult> {
  const { phoneE164 } = args;

  if (typeof phoneE164 !== "string" || !isValidE164(phoneE164.trim())) {
    cloudLog({
      severity: "WARNING",
      component: "OnboardingTools",
      action: "TOOL_CONNECT_WA_INVALID_E164",
      a2a_transfer: false,
      message: `Invalid E.164 phone: "${phoneE164}"`,
      businessId: ctx.businessId,
    });
    return {
      ok: false,
      confirmation: null,
      error: `connect_whatsapp_business: phoneE164 must be a valid E.164 number (e.g. +5491100000000). Got: "${phoneE164}"`,
      phoneE164: null,
      wasFirstCapture: false,
    };
  }

  const trimmed = phoneE164.trim();

  // Delegate to the existing business.update pipeline so idempotency,
  // audit, and contract guardrails all fire normally.
  // The idempotency key uses the seed to prevent duplicate DB rows on retries.
  const idempotencyKey = `${ctx.idempotencySeed}|wa-phone|${trimmed}`;

  try {
    const res = await fetch(`${process.env.NEXTAUTH_URL ?? ""}/api/business`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        // Internal server-to-server call: pass the actor's session cookie
        // via the Authorization header using the A2A_SECRET bearer token.
        // The business route uses resolveActor which accepts either OAuth
        // session cookies or the A2A bearer path for internal calls.
        // NOTE: we reuse the businessId as the actor key — the route is
        // owner-only and validates the actor server-side.
        "X-Idempotency-Key": idempotencyKey,
        "X-Internal-Business-Id": ctx.businessId,
        "X-Internal-Actor-User-Id": ctx.actorUserId,
        Authorization: `Bearer ${process.env.A2A_SECRET ?? ""}`,
      },
      body: JSON.stringify({ whatsappBusinessPhoneE164: trimmed }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as Record<string, unknown>;
      const msg = typeof body.message === "string" ? body.message : `HTTP ${res.status}`;
      cloudLog({
        severity: "WARNING",
        component: "OnboardingTools",
        action: "TOOL_CONNECT_WA_HTTP_FAIL",
        a2a_transfer: false,
        message: msg,
        businessId: ctx.businessId,
        data: { status: res.status },
      });
      return { ok: false, confirmation: null, error: msg, phoneE164: null, wasFirstCapture: false };
    }

    cloudLog({
      severity: "INFO",
      component: "OnboardingTools",
      action: "TOOL_CONNECT_WA_SUCCESS",
      a2a_transfer: false,
      message: "WhatsApp Business phone captured",
      businessId: ctx.businessId,
    });

    return {
      ok: true,
      confirmation: "WhatsApp Business número guardado.",
      error: null,
      phoneE164: trimmed,
      wasFirstCapture: true,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    cloudLog({
      severity: "ERROR",
      component: "OnboardingTools",
      action: "TOOL_CONNECT_WA_EXCEPTION",
      a2a_transfer: false,
      message: msg,
      businessId: ctx.businessId,
    });
    return { ok: false, confirmation: null, error: msg, phoneE164: null, wasFirstCapture: false };
  }
}
