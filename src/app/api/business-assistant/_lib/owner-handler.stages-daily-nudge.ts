// Once-daily proactive setup nudge — in-session, server-side, owner chat path only.
//
// Fires at most once per calendar day (ART timezone) when the owner opens the
// chat WITHOUT a substantive message and their onboarding is still incomplete.
// The Supervisor leads with a greeting + single onboarding gap + Sí/No chips
// so the owner can continue without having to ask anything.
//
// Idempotency: Business.lastProactiveNudgeAt is stamped on the first fire. The
// once-per-day check reads that field (no ChatMessage sentinel needed).
//
// Guard: fires ONLY when ctx.params.text is empty or a bare greeting. Any
// substantive message (e.g. "¿cuánto vendí hoy?") causes immediate return null
// so the real message flows through the normal pipeline.
//
// NO Cloud Scheduler. NO Web Push. Purely in-session, triggered by the owner's
// first chat message of the day.

import { prisma } from "@/lib/prisma";
import { cloudLog } from "@/lib/cloud-logger";
import { loadSupervisorContext } from "@/app/api/supervisor/_lib/load-context";
import type { OwnerPipelineStage } from "./owner-handler.stages";
import { getArgentinaDateString, getArgentinaDayStart } from "@/lib/argentina-date";

// Derive both the date string ("YYYY-MM-DD") and the start-of-day Date from a
// single base timestamp. Uses Intl-based helpers (DST-safe).
function artDateParts(now: Date): { dateStr: string; dayStart: Date } {
  const ms = now.getTime();
  return {
    dateStr: getArgentinaDateString(ms),
    dayStart: new Date(getArgentinaDayStart(ms)),
  };
}

// Bare-greeting words that do NOT count as substantive messages.
// Exported for unit-testing.
const GREETING_RE =
  /^\s*(hola|buen[ao]s?(\s+(d[ií]as?|noches?|tardes?))?|buen\s+d[ií]a|buenas|hey|hi|ey|good\s+(morning|afternoon|evening))\s*[!¡.]*\s*$/i;

/**
 * Returns true when `text` is empty, blank, or a bare greeting — i.e. the
 * owner opened the chat without asking anything specific. Exported so unit
 * tests can verify the guard without importing the full pipeline stage.
 */
export function isGreetingOrEmpty(text: string): boolean {
  if (!text || !text.trim()) return true;
  return GREETING_RE.test(text.trim());
}

/**
 * Returns true when ALL fast-path onboarding fields are complete.
 * Mirrors the full set of turns covered by the fast-path pipeline
 * (T1-businessName, T2-businessType, T3-paymentMethods, T3b-transferAlias,
 * T4-postalCode, T5-courierPreference, T6-whatsappPhone, T7-product/stock,
 * T9-MP or deferred). The opening-cash turn was removed in Fase B and is
 * intentionally absent here — see owner-handler.ts onboardingComplete.
 * Exported so the daily-nudge stage and any future fast-path stage can
 * share a single source of truth.
 */
export function isOnboardingFullyComplete(
  ctx: Awaited<ReturnType<typeof loadSupervisorContext>>,
): boolean {
  if (!ctx.businessNameSet) return false;
  if (!ctx.paymentMethodsSet) return false;
  if (ctx.productCount === 0) return false;
  if (!ctx.transferAliasSet) return false;
  if (!ctx.postalCodeSet) return false;
  if (!ctx.courierPreferenceSet) return false;
  if (!ctx.whatsappPhoneSet) return false;
  // T9: needs MP connected OR explicitly deferred.
  if (ctx.mercadoPagoSelected && !ctx.mercadoPagoConnected && !ctx.mercadoPagoOnboardingDeferred) {
    return false;
  }
  return true;
}

// Build the human-readable label for the FIRST canonical onboarding gap.
// Uses isOnboardingFullyComplete for the "done" check and mirrors the same
// field order so the nudge is consistent with the fast-path pipeline order.
// Returns null when onboarding is fully complete (no nudge needed).
//
// Extended 2026-05-20 to cover post-onboarding service connections (ARCA cert,
// courier creds, MODO). These don't block the initial onboarding completion
// flag (isOnboardingFullyComplete) but they DO matter for daily operations —
// e.g. picking Andreani as courier but never uploading creds means every sale
// with shipping will fail to quote.
function buildMissingLabel(ctx: Awaited<ReturnType<typeof loadSupervisorContext>>): string | null {
  if (!ctx.businessNameSet) return "el nombre del negocio";
  if (!ctx.paymentMethodsSet) return "los métodos de pago";
  if (ctx.productCount === 0) return "al menos un producto";
  if (!ctx.transferAliasSet) return "el alias o CBU de transferencia";
  if (!ctx.postalCodeSet) return "el código postal del negocio";
  if (!ctx.courierPreferenceSet) return "la preferencia de correo";
  if (!ctx.whatsappPhoneSet) return "el teléfono de WhatsApp";
  if (ctx.mercadoPagoSelected && !ctx.mercadoPagoConnected && !ctx.mercadoPagoOnboardingDeferred) {
    return "la conexión con Mercado Pago";
  }
  // Post-onboarding service gaps — surfaced ONLY after the 9 base fields are
  // done. These don't block onboarding but block real-world operations.
  if (ctx.courierPreferenceSet && !ctx.courierCredentialsConnected) {
    // Use the courier name (Andreani / OCA / Correo), NOT the business name.
    // Bug 2026-05-27: previous code interpolated ctx.businessName here, which
    // produced nonsense like "las credenciales de DISTRIBUIDORA MENDOZA".
    const courierName = ctx.courierPreference?.trim() || "tu courier";
    return `las credenciales de ${courierName}`;
  }
  // ARCA cert and MODO are optional — only flag if the cuit field is set
  // (signals owner cares about facturas) or modo is in paymentMethods.
  if (ctx.cuitSet && !ctx.arcaCertConnected) return "el certificado digital de AFIP para emitir facturas";
  return null; // onboarding complete
}

// Stamp Business.lastProactiveNudgeAt. Returns true on success (first write
// today); false when already stamped today or on DB error.
async function tryMarkNudgeSent(businessId: string, dayStart: Date): Promise<boolean> {
  try {
    // Only update if the field is still null or before today's ART day start.
    const result = await (prisma.business.updateMany as (args: unknown) => Promise<{ count: number }>)({
      where: {
        id: businessId,
        OR: [
          { lastProactiveNudgeAt: null },
          { lastProactiveNudgeAt: { lt: dayStart } },
        ],
      },
      data: { lastProactiveNudgeAt: new Date() },
    });
    return result.count > 0;
  } catch (error) {
    // Unexpected error: log and skip nudge gracefully — don't block the pipeline.
    cloudLog({
      severity: "WARNING",
      component: "System",
      action: "DAILY_NUDGE_STAMP_FAILED",
      a2a_transfer: false,
      message: "Could not stamp lastProactiveNudgeAt; skipping nudge",
      businessId,
      data: { error: error instanceof Error ? error.message : String(error) },
    });
    return false;
  }
}

// The pipeline stage itself.
export const ownerDailyNudgeStage: OwnerPipelineStage = {
  name: "ownerDailyNudge",
  run: async (ctx) => {
    const { text, businessId, actorUserId, respond, trace, latency } = ctx.params;

    // CRITICAL guard: only intercept empty or greeting-like turns.
    // Any substantive message must flow through the normal pipeline unchanged.
    if (!isGreetingOrEmpty(text)) return null;

    latency.start("preModel");

    // Fast reject: load supervisor context (lightweight — cached 30s).
    const supCtx = await loadSupervisorContext(businessId);

    // First-time guard: a brand-new owner (business name not yet set) has not
    // completed onboarding. The onboarding fast path stage runs before this one
    // in the pipeline, but this guard is belt-and-suspenders: if the onboarding
    // stage falls through for any reason, we must not fire a nudge that competes
    // with the onboarding welcome message.
    if (!supCtx.businessNameSet) {
      latency.end("preModel");
      return null;
    }

    const missingLabel = buildMissingLabel(supCtx);
    if (!missingLabel) {
      // Onboarding complete — no nudge needed.
      latency.end("preModel");
      return null;
    }

    const now = new Date();
    const { dateStr: artDateStr, dayStart } = artDateParts(now);

    // Check once-per-day via Business.lastProactiveNudgeAt (already-nudged fast path).
    // Cast: lastProactiveNudgeAt is not yet in the generated Prisma types
    // (schema was updated; next `prisma generate` will surface it).
    const biz = await (prisma.business.findUnique as (args: unknown) => Promise<{ lastProactiveNudgeAt: Date | null } | null>)({
      where: { id: businessId },
      select: { lastProactiveNudgeAt: true },
    });
    if (biz?.lastProactiveNudgeAt && biz.lastProactiveNudgeAt >= dayStart) {
      latency.end("preModel");
      return null;
    }

    // Attempt to stamp. Concurrent requests are handled by the updateMany
    // condition — only the first one wins (count > 0).
    const didWrite = await tryMarkNudgeSent(businessId, dayStart);
    latency.end("preModel");

    if (!didWrite) return null;

    // Build the greeting — use the business name when available.
    const greeting = supCtx.businessName
      ? `Buen día, ${supCtx.businessName}.`
      : "Buen día.";
    const nudgeText = `${greeting} Te falta ${missingLabel} para terminar de configurar tu negocio. ¿Lo armamos?`;

    const chips = {
      kind: "single",
      options: [
        { label: "Sí", value: "si" },
        { label: "Ahora no", value: "no" },
      ],
    };

    trace.add("routing", "owner → daily-nudge (proactive)");
    latency.setMeta("path", "owner-daily-nudge");
    latency.emit({ businessId, actorUserId, actorEmployeeId: null });

    cloudLog({
      severity: "INFO",
      component: "System",
      action: "OWNER_DAILY_NUDGE_SENT",
      a2a_transfer: false,
      message: "Proactive daily nudge fired",
      businessId,
      data: { missingLabel, artDateStr },
    });

    // NOTE: do NOT call persistNudgeMessage here. The respond() function routes
    // through finalisePost → scheduleReplyPersist, which already writes this
    // message with the deterministic `{requestId}-reply` clientMessageId.
    // Calling persistNudgeMessage in addition would produce a second ChatMessage
    // row with a different clientMessageId (proactive-nudge-*), causing the
    // duplicate-reply bug observed in /api/chat-history (two assistant rows ~9s apart).

    return respond({
      answer: nudgeText,
      actions: [],
      chips,
    });
  },
};
