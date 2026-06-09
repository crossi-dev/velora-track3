// Proactive MP reconnection nudge — writes an owner_only ChatMessage when
// MP credentials are stale/missing so the owner sees the issue next time
// they open the chat, instead of getting a silent failure on the next cobro.
//
// Deduplicated per businessId within a 30-min window so repeated agent calls
// (e.g. polling getStatus) do not spam the chat history.

import { cloudLog } from "@/lib/cloud-logger";
import { prisma } from "@/lib/prisma";

const MP_NUDGE_PREFIX = "mp-reconnect-nudge:";
const MP_NUDGE_WINDOW_MS = 30 * 60 * 1000;

export async function nudgeMpReconnect(
  businessId: string,
  reason: "expired" | "not_connected" | "decrypt_error",
): Promise<void> {
  if (!businessId) return;

  try {
    // Dedupe: skip if a nudge fired for this business within the last 30 min.
    const since = new Date(Date.now() - MP_NUDGE_WINDOW_MS);
    const recent = await prisma.chatMessage.findFirst({
      where: {
        businessId,
        clientMessageId: { startsWith: MP_NUDGE_PREFIX },
        createdAt: { gte: since },
      },
      select: { id: true },
    });
    if (recent) return;

    const message =
      reason === "expired"
        ? "Tu conexión con Mercado Pago venció. ¿La reconectamos para que puedas seguir cobrando con QR y links de pago?"
        : reason === "not_connected"
          ? "No te veo conectado con Mercado Pago. Conectalo cuando quieras y empezamos a cobrar con QR y links de pago."
          : "Tu token de Mercado Pago no se pudo leer (puede ser una clave que rotó). Reconectá la cuenta para volver a operar.";

    await prisma.chatMessage.create({
      data: {
        businessId,
        clientMessageId: `${MP_NUDGE_PREFIX}${businessId}:${Date.now()}`,
        kind: "reply",
        source: "manager",
        visibility: "owner_only",
        text: message,
      },
    });

    cloudLog({
      severity: "INFO",
      component: "A2A",
      action: "MP_RECONNECT_NUDGE",
      a2a_transfer: false,
      message: `MP reconnect nudge written for businessId=${businessId} reason=${reason}`,
      data: { businessId, reason },
    });
  } catch (err) {
    // Never throw — the nudge is best-effort, must not break the calling flow.
    cloudLog({
      severity: "WARNING",
      component: "A2A",
      action: "MP_RECONNECT_NUDGE_FAILED",
      a2a_transfer: false,
      message: "nudgeMpReconnect failed to write nudge ChatMessage",
      data: { businessId, error: err instanceof Error ? err.message : String(err) },
    });
  }
}
