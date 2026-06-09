import pLimit from "p-limit";
import { prisma } from "@/lib/prisma";
import { sendPush, type PushPayload } from "./web-push";
import { sendFcmNotification } from "@/lib/firebase-admin";
import { cloudLog } from "@/lib/cloud-logger";
import { injectPushResubPrompt } from "./push-resub-prompt";

// Misma concurrencia que rule-evaluation.ts y owner-push.ts.
const PUSH_CONCURRENCY = 5;

export async function sendPushToEmployee(
  businessId: string,
  employeeId: string,
  payload: PushPayload,
): Promise<void> {
  let subscriptions: Array<{ id: string; userId: string; endpoint: string; p256dh: string; auth: string; kind: string; fcmToken: string | null }>;
  try {
    subscriptions = await prisma.pushSubscription.findMany({
      where: { businessId, userId: employeeId, expired: false },
      select: { id: true, userId: true, endpoint: true, p256dh: true, auth: true, kind: true, fcmToken: true },
    });
  } catch {
    return;
  }

  if (subscriptions.length === 0) return;

  const limit = pLimit(PUSH_CONCURRENCY);
  let sent = 0;
  let expired = 0;
  const errors: string[] = [];

  await Promise.all(
    subscriptions.map((sub) =>
      limit(async () => {
        // DUAL-CHANNEL: route to FCM (Capacitor Android) or Web Push (browser).
        if (sub.kind === "fcm") {
          if (!sub.fcmToken) return;
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
            prisma.pushSubscription
              .update({ where: { id: sub.id }, data: { expired: true } })
              .catch(() => {});
            injectPushResubPrompt(businessId, sub.userId, "employee_only", employeeId).catch(() => {});
            expired += 1;
          }
          // firebase-not-configured → silent skip (degraded gracefully).
          return;
        }

        // Web Push (kind = "webpush" or legacy rows without kind).
        const result = await sendPush(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload,
        );
        if (result.ok) {
          sent += 1;
          return;
        }
        if (result.expired) {
          prisma.pushSubscription
            .update({ where: { id: sub.id }, data: { expired: true } })
            .catch(() => {});
          injectPushResubPrompt(businessId, sub.userId, "employee_only", employeeId).catch(() => {});
          expired += 1;
          return;
        }
        errors.push(result.error ?? `status=${result.statusCode}`);
        cloudLog({
          severity: "WARNING", component: "System", action: "EMPLOYEE_PUSH_FAILED",
          a2a_transfer: false, message: "Employee push failed",
          businessId, data: { employeeId, error: result.error ?? `status=${result.statusCode}` },
        });
      }),
    ),
  );

  // PUSH_FAILED agregado por businessId+employeeId — visibility para
  // empleados con todas las subs caídas (signal de re-onboarding).
  if (errors.length > 0 && sent === 0 && subscriptions.length > 0) {
    cloudLog({
      severity: "WARNING",
      component: "System",
      action: "PUSH_FAILED",
      a2a_transfer: false,
      message: "All employee push subscriptions failed after retry",
      businessId,
      data: { employeeId, attempted: subscriptions.length, expired, errorCount: errors.length, sample: errors.slice(0, 3) },
    });
  }
}
