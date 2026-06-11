// business-capabilities.ts — Per-tenant capability loader for capability-aware orchestration.
//
// Reads DB once per call and returns a typed shape describing which external
// services the business has connected. No in-process cache: freshness is required
// when the owner connects or disconnects a service during an active session.
//
// Design inspired by Stripe Incremental Onboarding (currently_due vs eventually_due):
//   https://docs.stripe.com/connect/required-verification-information
// The same "what does this business have right now" mental model drives which
// Supervisor tools are gated vs always-available.
//
// Encajonado providers — NOT exposed in this shape per Carlos 2026-05-28 directive:
//   OCA:     code exists in Velora but no active onboarding path.
//   Correo:  same.
//   Neither appears in Supervisor routing, Services tab, or Onboarding prompts.

import { prisma } from "@/lib/prisma";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Capability flags for a single business. Each flag reflects whether the
 * business has completed the minimum setup for that provider.
 *
 * Always-on capabilities (Ventas, Communications, Onboarding, Equipo) are
 * intentionally omitted — they need no DB signal.
 */
export interface BusinessCapabilities {
  /** WabaConnection row exists — full Meta Embedded Signup completed. */
  whatsapp_business: boolean;
  /** Business.whatsappBusinessPhoneE164 is set — lower-tier signal pre-Embedded-Signup. */
  whatsapp_phone: boolean;
  /** MpConnection row exists — MercadoPago OAuth connected. */
  mercadopago: boolean;
  /** Business.alias is set — alias/CBU transfer path available. */
  alias_cbu: boolean;
  /** ArcaCredential row exists — AFIP/ARCA fiscal credentials on file. */
  arca: boolean;
  /** CourierCredential row for provider="andreani" exists. */
  andreani: boolean;
  /** BusinessChannelCredential row for provider="twilio_sms" exists. */
  twilio_sms: boolean;
  /** BusinessChannelCredential row for provider="resend" exists. */
  resend: boolean;
  /** BusinessChannelCredential row for provider="pedidosya" exists. */
  pedidosya: boolean;
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/**
 * Load capability flags for the given business. Executes a single Prisma query
 * with `select` to minimise data transfer — only the fields needed for the flags
 * are fetched.
 *
 * Returns all-false for an unknown businessId (same as an empty business).
 */
export async function loadBusinessCapabilities(
  businessId: string,
): Promise<BusinessCapabilities> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- whatsappBusinessPhoneE164 and wabaConnection are new schema fields; Prisma client regen is blocked on shared node_modules DLL lock in worktree. Cast until next full generate.
  const biz = await (prisma.business.findUnique as any)({
    where: { id: businessId },
    select: {
      // Lower-tier WA signal — presence alone is the signal.
      whatsappBusinessPhoneE164: true,
      // Alias/CBU transfer path.
      alias: true,
      // Full WABA connection.
      wabaConnection: { select: { id: true } },
      // MercadoPago OAuth.
      mpConnection: { select: { id: true } },
      // AFIP/ARCA fiscal credentials.
      arcaCredential: { select: { id: true } },
      // Courier credentials — only andreani is active; OCA + Correo are shelved.
      courierCredentials: {
        where: { provider: "andreani" },
        select: { id: true },
      },
      // Communication channel credentials (BYOA): twilio_sms, resend, pedidosya.
      businessChannelCredentials: {
        select: { provider: true },
      },
    },
  });

  if (!biz) {
    return {
      whatsapp_business: false,
      whatsapp_phone: false,
      mercadopago: false,
      alias_cbu: false,
      arca: false,
      andreani: false,
      twilio_sms: false,
      resend: false,
      pedidosya: false,
    };
  }

  const channelProviders = new Set(
    biz.businessChannelCredentials.map((c: { provider: string }) => c.provider),
  );

  return {
    whatsapp_business: biz.wabaConnection !== null,
    whatsapp_phone:
      biz.whatsappBusinessPhoneE164 !== null &&
      biz.whatsappBusinessPhoneE164 !== "",
    mercadopago: biz.mpConnection !== null,
    alias_cbu: biz.alias !== null && biz.alias.trim() !== "",
    arca: biz.arcaCredential !== null,
    andreani: biz.courierCredentials.length > 0,
    twilio_sms: channelProviders.has("twilio_sms"),
    resend:     channelProviders.has("resend"),
    pedidosya:  channelProviders.has("pedidosya"),
  };
}
