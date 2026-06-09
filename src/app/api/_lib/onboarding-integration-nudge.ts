// Shared helper for proactive onboarding integration nudges.
//
// Sends a ChatMessage nudge to the owner for a specific integration when:
//   (a) PROACTIVE_ONBOARDING_ENABLED=true
//   (b) The integration's NudgeShownAt is NULL (or it's a new ART day)
//   (c) The dismiss gate has elapsed (48h since NudgeDismissedAt)
//   (d) The integration is still NOT connected (fresh read — TOCTOU fix §14.1)
//
// Atomic dedup: clientMessageId = "onboarding-nudge:{businessId}:{integration}:{slotDate}"
// where slotDate = ART calendar day (YYYY-MM-DD, UTC-3). The UNIQUE constraint on
// ChatMessage.clientMessageId is the real dedup (P2002 = already shown today).
//
// NudgeShownAt and the ChatMessage insert share a $transaction([...]) batch
// (pgbouncer transaction-mode safe — NOT the interactive-callback form).
//
// Sources:
//   - first-sale-nudge cron pattern (dedup via clientMessageId UNIQUE)
//   - condition-stock-rules.ts post-commit observer pattern
//   - design §6 / §14.1 (TOCTOU fresh read before insert)

import { prisma } from "@/lib/prisma";
import { cloudLog } from "@/lib/cloud-logger";
import { getArgentinaDateString } from "@/app/dashboard/lib/today-summary";

export type Integration = "mp" | "whatsapp" | "andreani" | "arca";

export type NudgeResult =
  | "sent"
  | "skip_flag_off"
  | "skip_connected"
  | "skip_shown_today"
  | "skip_dismissed"
  | "skip_no_business"
  | "duplicate"    // P2002 — another instance beat us
  | "internal_error"; // unexpected DB/runtime error — distinct from flag-off

const DISMISS_GATE_MS = 48 * 60 * 60 * 1000; // 48h

// Column map — must stay in sync with Prisma schema.
const SHOWN_AT_COL: Record<Integration, "mpNudgeShownAt" | "whatsappNudgeShownAt" | "andreaniNudgeShownAt" | "arcaNudgeShownAt"> = {
  mp: "mpNudgeShownAt",
  whatsapp: "whatsappNudgeShownAt",
  andreani: "andreaniNudgeShownAt",
  arca: "arcaNudgeShownAt",
};

const DISMISSED_AT_COL: Record<Integration, "mpNudgeDismissedAt" | "whatsappNudgeDismissedAt" | "andreaniNudgeDismissedAt" | "arcaNudgeDismissedAt"> = {
  mp: "mpNudgeDismissedAt",
  whatsapp: "whatsappNudgeDismissedAt",
  andreani: "andreaniNudgeDismissedAt",
  arca: "arcaNudgeDismissedAt",
};

const NUDGE_COPY: Record<Integration, string> = {
  mp: "Registraste tu primera venta. ¿La querés cobrar con QR o link de pago? Conectá Mercado Pago y listo — decime \"conectar MP\" cuando quieras.",
  whatsapp: "Ya tenés tu catálogo. ¿Querés que te avise por WhatsApp cuando entren ventas o quede poco stock? Agregá tu número y empezamos.",
  andreani: "¿Necesitás enviar el pedido? Conectá Andreani y te armo el envío al toque — decime \"conectar Andreani\" cuando quieras.",
  arca: "¿Necesitás factura electrónica para este cliente? Conectá ARCA/AFIP y la emito automáticamente — decime \"conectar facturación\" cuando quieras.",
};

export interface MaybeSendIntegrationNudgeArgs {
  businessId: string;
  integration: Integration;
}

/**
 * Attempts to send a proactive integration nudge to the owner chat.
 *
 * Returns the reason for skipping or "sent" / "duplicate" on success.
 * NEVER throws — all errors are absorbed and logged.
 */
export async function maybeSendIntegrationNudge(
  args: MaybeSendIntegrationNudgeArgs,
): Promise<NudgeResult> {
  const { businessId, integration } = args;

  // Feature flag gate.
  if (process.env.PROACTIVE_ONBOARDING_ENABLED !== "true") {
    return "skip_flag_off";
  }

  const shownAtCol = SHOWN_AT_COL[integration];
  const dismissedAtCol = DISMISSED_AT_COL[integration];
  const slotDate = getArgentinaDateString(Date.now()); // YYYY-MM-DD ART
  const clientMessageId = `onboarding-nudge:${businessId}:${integration}:${slotDate}`;

  try {
    // Read the nudge state + dismiss timestamp from the Business row.
    const biz = await prisma.business.findUnique({
      where: { id: businessId },
      select: {
        [shownAtCol]: true,
        [dismissedAtCol]: true,
      },
    });

    if (!biz) return "skip_no_business";

    const shownAt = (biz as Record<string, unknown>)[shownAtCol] as Date | null;
    const dismissedAt = (biz as Record<string, unknown>)[dismissedAtCol] as Date | null;

    // If already shown today (shownAt is in the same ART day) AND a ChatMessage
    // already exists for this slotDate, we'd hit P2002 anyway — but short-circuit
    // early for cheap exit.
    if (shownAt !== null) {
      const shownSlot = getArgentinaDateString(shownAt.getTime());
      if (shownSlot === slotDate) return "skip_shown_today";
    }

    // 48h dismiss gate.
    if (dismissedAt !== null) {
      const elapsed = Date.now() - dismissedAt.getTime();
      if (elapsed < DISMISS_GATE_MS) return "skip_dismissed";
    }

    // TOCTOU fix (design §14.1): re-read integration-connected FRESH right before
    // inserting, so an owner who just connected won't get a stale "please connect" nudge.
    const connected = await isIntegrationConnected(businessId, integration);
    if (connected) return "skip_connected";

    // Atomic batch: insert ChatMessage + stamp NudgeShownAt.
    // Batch/array form is pgbouncer transaction-mode safe (NOT the callback form).
    try {
      await prisma.$transaction([
        prisma.chatMessage.create({
          data: {
            businessId,
            clientMessageId,
            kind: "reply",
            source: "manager",
            visibility: "owner_only",
            text: NUDGE_COPY[integration],
          },
        }),
        prisma.business.update({
          where: { id: businessId },
          data: { [shownAtCol]: new Date() },
        }),
      ]);

      cloudLog({
        severity: "INFO",
        component: "System",
        action: "ONBOARDING_INTEGRATION_NUDGE_SENT",
        a2a_transfer: false,
        message: `Integration nudge sent: ${integration}`,
        businessId,
        data: { integration, clientMessageId, slotDate },
      });

      return "sent";
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code === "P2002") {
        // Concurrent instance already wrote this nudge — idempotent no-op.
        cloudLog({
          severity: "INFO",
          component: "System",
          action: "ONBOARDING_INTEGRATION_NUDGE_DUPLICATE",
          a2a_transfer: false,
          message: `Integration nudge duplicate (P2002): ${integration}`,
          businessId,
          data: { integration, clientMessageId, slotDate },
        });
        return "duplicate";
      }
      throw err;
    }
  } catch (err) {
    cloudLog({
      severity: "WARNING",
      component: "System",
      action: "ONBOARDING_INTEGRATION_NUDGE_FAILED",
      a2a_transfer: false,
      message: `Integration nudge failed: ${integration}`,
      businessId,
      data: {
        integration,
        error: err instanceof Error ? err.message : String(err),
      },
    });
    // Never propagate — nudge is best-effort.
    // Return "internal_error" (not "skip_flag_off") so the cron can count real
    // failures separately from normal flag-off skips (data-integrity fix §2).
    return "internal_error";
  }
}

/**
 * Fresh-read of whether an integration is connected.
 * Used for TOCTOU protection: queries the credential tables directly,
 * NOT the 30s fetchSupervisorContext cache (design §9, §14.1).
 */
async function isIntegrationConnected(
  businessId: string,
  integration: Integration,
): Promise<boolean> {
  switch (integration) {
    case "mp": {
      const row = await prisma.mpConnection.findUnique({
        where: { businessId },
        select: { id: true },
      });
      return row !== null;
    }
    case "whatsapp": {
      const row = await prisma.business.findUnique({
        where: { id: businessId },
        select: { whatsappPhone: true },
      });
      return typeof row?.whatsappPhone === "string" && row.whatsappPhone.trim().length > 0;
    }
    case "andreani": {
      // courierCredentialsConnected mirrors supervisor context logic:
      // connected = either a CourierCredential row OR a BYOA token,
      // AND the preference is set to "andreani" (or "ninguno" = no shipping needed).
      const row = await prisma.business.findUnique({
        where: { id: businessId },
        select: {
          courierPreference: true,
          andreaniApiToken: true,
          andreaniTokenPendingStep: true,
        },
      });
      if (!row) return false;
      const pref = row.courierPreference?.trim().toLowerCase() ?? "";
      if (pref === "ninguno") return true; // no courier needed
      if (pref !== "andreani") return false;
      // Check BYOA token
      if (typeof row.andreaniApiToken === "string" && row.andreaniApiToken.trim().length > 0) return true;
      // Check classic credential row
      const cred = await prisma.courierCredential.findFirst({
        where: { businessId },
        select: { provider: true },
      });
      return cred !== null && cred.provider.trim().toLowerCase() === "andreani";
    }
    case "arca": {
      const row = await prisma.business.findUnique({
        where: { id: businessId },
        select: { arcaDelegationCuit: true },
      });
      const byoa = typeof row?.arcaDelegationCuit === "string" && row.arcaDelegationCuit.trim().length > 0;
      if (byoa) return true;
      const cred = await prisma.arcaCredential.findUnique({
        where: { businessId },
        select: { id: true },
      });
      return cred !== null;
    }
  }
}
