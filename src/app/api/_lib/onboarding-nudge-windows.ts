// Shared window/priority logic for the onboarding integration nudge chain.
//
// Extracted from the now-deleted cron so both the Cloud Tasks worker
// (onboarding-nudge route) and tests can import it without duplicating the
// business rules.
//
// The idle windows are anchored to Business.firstSaleAt (design §14.4).
// Priority: cobro > envío > factura > whatsapp (design §6).
//
// Note: Andreani/ARCA/WhatsApp windows are ideally anchored to per-intent
// stamps ("first dispatch intent", "first invoice intent", etc.) — see CLAUDE.md.
// Those columns are not yet stamped separately; firstSaleAt is the shared anchor.

import { prisma } from "@/lib/prisma";
import { getArgentinaDateString } from "@/app/dashboard/lib/today-summary";
import type { Integration } from "@/app/api/_lib/onboarding-integration-nudge";

// Idle windows in milliseconds (from firstSaleAt anchor).
export const IDLE_WINDOWS_MS: Record<Integration, number> = {
  mp: 24 * 60 * 60 * 1000,        // 24h
  whatsapp: 48 * 60 * 60 * 1000,  // 48h
  andreani: 48 * 60 * 60 * 1000,  // 48h
  arca: 72 * 60 * 60 * 1000,      // 72h
};

// Priority order: cobro > envío > factura > whatsapp (design §6).
export const INTEGRATION_PRIORITY: Integration[] = ["mp", "andreani", "arca", "whatsapp"];

// Default delay for the first nudge task (MP window = 24h).
// The worker re-schedules subsequent tasks using the next integration's window.
export const INITIAL_DELAY_SECONDS = 24 * 60 * 60; // 24h

// Max nudge attempts per user. After this many deliveries the chain stops.
// Env-overridable so ops can tune without a deploy.
// Default 5: mp(24h) + andreani(48h) + arca(72h) + whatsapp(48h) + one final retry.
export function getMaxAttempts(): number {
  const raw = process.env.ONBOARDING_NUDGE_MAX_ATTEMPTS;
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 5;
}

export interface NudgeWindowState {
  /** firstSaleAt anchor — null means no first sale yet (no-op). */
  firstSaleAt: Date | null;
  mpNudgeShownAt: Date | null;
  whatsappNudgeShownAt: Date | null;
  andreaniNudgeShownAt: Date | null;
  arcaNudgeShownAt: Date | null;
}

/**
 * Selects the highest-priority integration whose idle window has elapsed
 * since firstSaleAt, AND which has not already received an idle nudge today.
 *
 * Returns null when:
 *   - firstSaleAt is null (gate not released)
 *   - all integration windows are in the future
 *   - all eligible integrations were already nudged today (one-per-ART-day cap)
 */
export function pickDueIntegration(
  state: NudgeWindowState,
  nowMs: number,
): Integration | null {
  if (!state.firstSaleAt) return null;

  const anchorMs = state.firstSaleAt.getTime();
  const todayART = getArgentinaDateString(nowMs);

  const shownAtMap: Record<Integration, Date | null> = {
    mp: state.mpNudgeShownAt,
    whatsapp: state.whatsappNudgeShownAt,
    andreani: state.andreaniNudgeShownAt,
    arca: state.arcaNudgeShownAt,
  };

  // Check if already nudged today across any integration (one-per-ART-day idle cap).
  const nudgedToday = INTEGRATION_PRIORITY.some((integration) => {
    const shownAt = shownAtMap[integration];
    return shownAt !== null && getArgentinaDateString(shownAt.getTime()) === todayART;
  });

  if (nudgedToday) return null;

  // Pick first eligible by priority.
  for (const integration of INTEGRATION_PRIORITY) {
    const windowMs = IDLE_WINDOWS_MS[integration];
    if (nowMs - anchorMs < windowMs) continue; // window not elapsed
    return integration;
  }

  return null;
}

/**
 * Loads the nudge window state for a business from the DB.
 * Returns null when the business row is not found.
 */
export async function loadNudgeWindowState(
  businessId: string,
): Promise<NudgeWindowState | null> {
  const row = await prisma.business.findUnique({
    where: { id: businessId },
    select: {
      firstSaleAt: true,
      mpNudgeShownAt: true,
      whatsappNudgeShownAt: true,
      andreaniNudgeShownAt: true,
      arcaNudgeShownAt: true,
    },
  });
  if (!row) return null;
  return {
    firstSaleAt: row.firstSaleAt,
    mpNudgeShownAt: row.mpNudgeShownAt,
    whatsappNudgeShownAt: row.whatsappNudgeShownAt,
    andreaniNudgeShownAt: row.andreaniNudgeShownAt,
    arcaNudgeShownAt: row.arcaNudgeShownAt,
  };
}

/**
 * Returns true when at least one integration is still unconnected.
 * Used by the worker to decide whether to re-schedule the next attempt.
 * Reads from the DB fresh (TOCTOU-safe, same pattern as maybeSendIntegrationNudge).
 */
export async function hasUnconnectedIntegrations(
  businessId: string,
): Promise<boolean> {
  const row = await prisma.business.findUnique({
    where: { id: businessId },
    select: {
      whatsappPhone: true,
      courierPreference: true,
      andreaniApiToken: true,
      arcaDelegationCuit: true,
    },
  });
  if (!row) return false;

  // MP: check MpConnection row.
  const mp = await prisma.mpConnection.findUnique({
    where: { businessId },
    select: { id: true },
  });
  if (!mp) return true;

  // WhatsApp: whatsappPhone set.
  const waPhone = typeof row.whatsappPhone === "string" && row.whatsappPhone.trim().length > 0;
  if (!waPhone) return true;

  // Andreani: same logic as isIntegrationConnected in onboarding-integration-nudge.ts.
  const pref = row.courierPreference?.trim().toLowerCase() ?? "";
  if (pref !== "ninguno") {
    const andreaniOk =
      (typeof row.andreaniApiToken === "string" && row.andreaniApiToken.trim().length > 0) ||
      (await prisma.courierCredential.findFirst({ where: { businessId }, select: { provider: true } })) !== null;
    if (!andreaniOk) return true;
  }

  // ARCA: arcaDelegationCuit or ArcaCredential row.
  const arcaOk =
    (typeof row.arcaDelegationCuit === "string" && row.arcaDelegationCuit.trim().length > 0) ||
    (await prisma.arcaCredential.findUnique({ where: { businessId }, select: { id: true } })) !== null;
  if (!arcaOk) return true;

  return false;
}
