// Capability cache freshness for onboarding turns (design §9).
//
// The 30s in-process cache in fetchSupervisorContext is per-instance and not
// cross-instance invalidated. To avoid nudging for an integration the owner
// just connected, capability fields are fetched FRESH on each onboarding turn.
// Cost: one extra light query per onboarding turn — acceptable (design §9).
//
// Returns only the 4 fields that bypass the cache; the caller merges them
// into the OnboardingState built from the cached supCtx.
//
// OAuth re-entry handshake (design §6/§14.8):
// detectConnectedFlip compares the pre-fetch cached values against the fresh
// read. If an integration transitioned false→true, the agent acknowledges it
// on the NEXT onboarding turn. Runs ONLY while onboarding is active (caller
// must guard). Source: ADK long-running resume-from-state pattern.
// [developers.googleblog.com/build-long-running-ai-agents-...]

import { prisma } from "@/lib/prisma";
import { getArgentinaDateString } from "@/app/dashboard/lib/today-summary";

export interface FreshCapabilities {
  mercadoPagoConnected: boolean;
  arcaCertConnected: boolean;
  courierCredentialsConnected: boolean;
  whatsappPhoneSet: boolean;
}

/**
 * Fetches integration-connected state directly from the DB, bypassing the
 * 30s in-process fetchSupervisorContext cache.
 *
 * Best-effort: never throws. On any DB error, the caller should fall back
 * to the cached supCtx values already in OnboardingState.
 */
export async function fetchFreshCapabilities(businessId: string): Promise<FreshCapabilities> {
  // Parallel queries — same tables as fetchSupervisorContext optional section.
  const [mpRow, arcaRow, courierRow, bizRow] = await Promise.allSettled([
    prisma.mpConnection.findUnique({ where: { businessId }, select: { id: true } }),
    prisma.arcaCredential.findUnique({ where: { businessId }, select: { id: true } }),
    prisma.courierCredential.findFirst({ where: { businessId }, select: { provider: true } }),
    prisma.business.findUnique({
      where: { id: businessId },
      select: {
        whatsappPhone: true,
        courierPreference: true,
        andreaniApiToken: true,
        arcaDelegationCuit: true,
      },
    }),
  ]);

  const mp = mpRow.status === "fulfilled" ? mpRow.value : null;
  const arca = arcaRow.status === "fulfilled" ? arcaRow.value : null;
  const courier = courierRow.status === "fulfilled" ? courierRow.value : null;
  const biz = bizRow.status === "fulfilled" ? bizRow.value : null;

  const pref = biz?.courierPreference?.trim().toLowerCase() ?? "";
  const byoaArcaDelegation = typeof biz?.arcaDelegationCuit === "string" &&
    biz.arcaDelegationCuit.trim().length > 0;
  const byoaAndreaniToken = typeof biz?.andreaniApiToken === "string" &&
    biz.andreaniApiToken.trim().length > 0;

  return {
    mercadoPagoConnected: mp !== null,
    arcaCertConnected: arca !== null || byoaArcaDelegation,
    courierCredentialsConnected:
      pref === "ninguno" ||
      (courier !== null && pref === courier.provider.trim().toLowerCase()) ||
      (byoaAndreaniToken && pref === "andreani"),
    whatsappPhoneSet:
      typeof biz?.whatsappPhone === "string" && biz.whatsappPhone.trim().length > 0,
  };
}

/**
 * Normalizes whatsappPhoneSet from the raw phone string stored in supCtx.
 *
 * supCtx.whatsappPhoneSet uses a lenient check (not-null/undefined), so the
 * deferred sentinel "" evaluates to true there. fetchFreshCapabilities uses
 * strict (trim().length > 0), so "" = false. Callers that compare cached vs
 * fresh must normalize to the strict definition before calling detectConnectedFlip.
 *
 * @param whatsappPhoneRaw - raw phone string from supCtx (may be undefined)
 * @param fallback - value to use when whatsappPhoneRaw is not a string
 */
export function normalizeWhatsappPhoneSetFromRaw(
  whatsappPhoneRaw: unknown,
  fallback: boolean,
): boolean {
  return typeof whatsappPhoneRaw === "string"
    ? whatsappPhoneRaw.trim().length > 0
    : fallback;
}

/** Which integrations are named for the OAuth re-entry handshake acknowledgment. */
export type ConnectedIntegration = "mercadopago" | "arca" | "courier" | "whatsapp";

/**
 * Detects which integrations just connected (false in cached → true in fresh).
 *
 * Returns the first flipped integration name, or null if nothing changed.
 * Only the FIRST flip is returned — one acknowledgment per turn is enough.
 * The caller must only call this while onboarding is active (design §14.8).
 *
 * Limitation: the cached values may be up to 30s stale (per-instance cache),
 * so a flip detected here means "connected since the last cache snapshot",
 * not precisely "connected since the last turn". This is the minimal state
 * available without adding a per-session marker (design §6 — keep it minimal).
 */
export function detectConnectedFlip(
  cached: FreshCapabilities,
  fresh: FreshCapabilities,
): ConnectedIntegration | null {
  if (!cached.mercadoPagoConnected && fresh.mercadoPagoConnected) return "mercadopago";
  if (!cached.arcaCertConnected && fresh.arcaCertConnected) return "arca";
  if (!cached.courierCredentialsConnected && fresh.courierCredentialsConnected) return "courier";
  if (!cached.whatsappPhoneSet && fresh.whatsappPhoneSet) return "whatsapp";
  return null;
}

/** Warm acknowledgment copy for each integration (Rioplatense, warm tone). */
export function buildOAuthAck(integration: ConnectedIntegration): string {
  switch (integration) {
    case "mercadopago": return "Listo, Mercado Pago quedó conectado. Ahora podés cobrar por link desde el chat.";
    case "arca":        return "Listo, AFIP/ARCA quedó conectado. Ya podés emitir facturas electrónicas.";
    case "courier":     return "Listo, el servicio de envíos quedó conectado. Podés despachar desde el chat.";
    case "whatsapp":    return "Listo, WhatsApp quedó conectado. Tus clientes pueden escribirte directo.";
  }
}

/**
 * Atomically claims the right to emit an OAuth re-entry ack for a given
 * integration on the current ART calendar day.
 *
 * Uses a dedicated OnboardingOauthAck row (NOT ChatMessage) so the dedup
 * token is invisible to chat-history queries and to the recentAlerts Supervisor
 * prompt injection (both of which filter on ChatMessage source/visibility).
 *
 * Cross-instance dedup: the @@unique([businessId, integration, slotDate])
 * constraint guarantees at-most-once per integration per ART day across ALL
 * Cloud Run instances.
 *
 * Returns true  → claim succeeded; caller may emit the visible ack via respond().
 * Returns false → P2002; another instance already claimed it for today; fall
 *                 through to normal turn processing.
 * Throws on unexpected errors (caller wraps in try/catch and falls through).
 *
 * slotDate = ART YYYY-MM-DD (UTC-3): reconnect fires a new ack the next ART day.
 *
 * pgbouncer-safe: single prisma.onboardingOauthAck.create (no interactive $transaction).
 */
export async function claimOAuthAck(
  businessId: string,
  integration: ConnectedIntegration,
): Promise<boolean> {
  const slotDate = getArgentinaDateString(Date.now()); // YYYY-MM-DD ART
  try {
    await prisma.onboardingOauthAck.create({
      data: { businessId, integration, slotDate },
    });
    return true;
  } catch (err) {
    if ((err as { code?: string })?.code === "P2002") return false;
    throw err;
  }
}
