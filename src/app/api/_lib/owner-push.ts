// Push fan-out al dueño del negocio. Originariamente vivía inline en el
// daily-summary cron — extraído acá para que también lo pueda usar el
// loop A2A Empleado→Supervisor cuando el Supervisor decide notificar
// inmediatamente (level: "now"). Marca expired las subscripciones que el
// push service rechaza con 404/410, igual que el cron.

import pLimit from "p-limit";
import { prisma } from "@/lib/prisma";
import { cloudLog } from "@/lib/cloud-logger";
import { sendPush, type PushPayload } from "./web-push";
import { sendFcmNotification } from "@/lib/firebase-admin";
import { injectPushResubPrompt } from "./push-resub-prompt";

// Misma concurrencia que rule-evaluation.ts — bounded fan-out evita spike
// si un dueño tiene muchas subs (multi-device + browsers).
const PUSH_CONCURRENCY = 5;

interface PushFanoutResult {
  attempted: number;
  sent: number;
  expired: number;
  errors: string[];
}

/**
 * Envía una push notification a TODAS las subscripciones activas del
 * dueño del business. Mejor esfuerzo: nunca tira; logea errores y sigue.
 * Retorna contadores para que el caller pueda loguear según corresponda.
 */
export async function sendPushToOwner(
  businessId: string,
  payload: PushPayload,
): Promise<PushFanoutResult> {
  const result: PushFanoutResult = { attempted: 0, sent: 0, expired: 0, errors: [] };

  const biz = await prisma.business.findUnique({ where: { id: businessId }, select: { userId: true } });
  if (!biz?.userId) return result;

  const subscriptions = await prisma.pushSubscription.findMany({
    where: { businessId, userId: biz.userId, expired: false },
    select: { id: true, userId: true, endpoint: true, p256dh: true, auth: true, kind: true, fcmToken: true },
  });

  result.attempted = subscriptions.length;
  if (subscriptions.length === 0) return result;

  const limit = pLimit(PUSH_CONCURRENCY);
  let sent = 0;
  let expired = 0;
  const errors: string[] = [];

  await Promise.all(
    subscriptions.map((sub) =>
      limit(async () => {
        // DUAL-CHANNEL: route to FCM (Capacitor Android) or Web Push (browser).
        if (sub.kind === "fcm") {
          if (!sub.fcmToken) return; // Malformed row — skip silently.
          const fcmResult = await sendFcmNotification(
            sub.fcmToken,
            payload.title,
            payload.body,
            { url: payload.url, notificationCategory: payload.notificationCategory, entityId: payload.entityId },
          );
          if (fcmResult.ok) {
            sent += 1;
            return;
          }
          if (fcmResult.reason === "invalid-token") {
            try {
              await prisma.pushSubscription.update({ where: { id: sub.id }, data: { expired: true } });
            } catch { /* race — non-critical */ }
            injectPushResubPrompt(businessId, sub.userId, "owner_only", null).catch(() => {});
            expired += 1;
            return;
          }
          if (fcmResult.reason !== "firebase-not-configured") {
            errors.push(`fcm:${fcmResult.reason}`);
          }
          return;
        }

        // Web Push (kind = "webpush" or legacy rows without kind).
        const sendResult = await sendPush(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload,
        );
        if (sendResult.ok) {
          sent += 1;
          return;
        }
        if (sendResult.expired) {
          try {
            await prisma.pushSubscription.update({
              where: { id: sub.id },
              data: { expired: true },
            });
          } catch {
            // Race con otro updater. No crítico — la próxima fanout lo va a marcar.
          }
          injectPushResubPrompt(businessId, sub.userId, "owner_only", null).catch(() => {});
          expired += 1;
          return;
        }
        errors.push(sendResult.error ?? `status=${sendResult.statusCode}`);
      }),
    ),
  );

  result.sent = sent;
  result.expired = expired;
  result.errors = errors;

  // PUSH_FAILED estructurado por businessId — agrupando arriba dejamos
  // detectar dueños con todas las subs caídas (signal de re-onboarding).
  if (errors.length > 0 && sent === 0 && result.attempted > 0) {
    cloudLog({
      severity: "WARNING",
      component: "System",
      action: "PUSH_FAILED",
      a2a_transfer: false,
      message: "All owner push subscriptions failed after retry",
      businessId,
      data: { attempted: result.attempted, expired, errorCount: errors.length, sample: errors.slice(0, 3) },
    });
  }

  return result;
}
