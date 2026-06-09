// Thin wrapper around the `web-push` library so route handlers don't talk
// to it directly. Two responsibilities:
//   1. Lazy VAPID configuration from env vars (throws on first call if any
//      of the four required vars is missing — fails fast, never silently).
//   2. Classify push-service responses so the cron can mark dead
//      subscriptions without leaking library internals.

import webpush from "web-push";
import { cloudLog } from "@/lib/cloud-logger";

export interface PushSubscriptionLike {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
}

export interface PushSendResult {
  ok: boolean;
  expired: boolean;
  statusCode: number | null;
  error?: string;
}

// Notification categories understood by the SW tag-namespace strategy.
// Keep in sync with the SW at /api/service-worker.
export type NotificationCategory =
  | "sale_confirmation"
  | "rule_alert"
  | "daily_summary"
  | "anomaly"
  | "default";

export interface PushPayload {
  title: string;
  body: string;
  url: string;
  notificationCategory: NotificationCategory;
  entityId: string;
}

// RFC 5322 basic email regex — good enough for a mailto: subject validation.
const MAILTO_EMAIL_RE = /^mailto:[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
const FALLBACK_SUBJECT = "mailto:noreply@somosvelora.com";
const MAX_PUSH_PAYLOAD_BYTES = 4096;

let configured = false;

function configure() {
  if (configured) return;
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const contact = process.env.VAPID_CONTACT_EMAIL;
  if (!publicKey || !privateKey || !contact) {
    throw new Error("VAPID_NOT_CONFIGURED");
  }
  // L2: validate mailto: subject — malformed subject causes push service rejection.
  const subject = contact.startsWith("mailto:") ? contact : `mailto:${contact}`;
  if (!MAILTO_EMAIL_RE.test(subject)) {
    cloudLog({
      severity: "ERROR",
      component: "System",
      action: "VAPID_SUBJECT_INVALID",
      a2a_transfer: false,
      message: `VAPID subject malformed: "${subject}" — falling back to ${FALLBACK_SUBJECT}`,
      data: { contact },
    });
    webpush.setVapidDetails(FALLBACK_SUBJECT, publicKey, privateKey);
  } else {
    webpush.setVapidDetails(subject, publicKey, privateKey);
  }
  configured = true;
}

// Push services return 404 when the endpoint never existed, 410 when it was
// once valid but the user uninstalled / cleared site data. Both are terminal
// for the subscription. 401/403 occur when the server's VAPID key no longer
// matches the subscription's recorded key — happens to pre-rotation subscribers
// after a VAPID key rotation; treat as expired so the cron skips and cleans them.
// 5xx is transient and should NOT mark expired.
function isExpired(statusCode: number | null) {
  return statusCode === 401 || statusCode === 403 || statusCode === 404 || statusCode === 410;
}

// Single attempt — separated so the retry wrapper can decide based on
// statusCode whether the failure is transient (5xx / no statusCode) or
// terminal (404/410 → expired, 4xx → don't retry).
async function sendPushOnce(
  subscription: PushSubscriptionLike,
  payload: PushPayload,
): Promise<PushSendResult> {
  try {
    // M1: validate payload size before sending. Push services enforce a
    // 4096-byte limit; exceeding it causes an opaque 413 from some services.
    let serialized = JSON.stringify(payload);
    if (serialized.length >= MAX_PUSH_PAYLOAD_BYTES) {
      const truncatedBody = payload.body.slice(0, Math.max(0, payload.body.length - (serialized.length - MAX_PUSH_PAYLOAD_BYTES + 10)));
      const truncated: PushPayload = { ...payload, body: truncatedBody };
      serialized = JSON.stringify(truncated);
      cloudLog({
        severity: "ERROR",
        component: "System",
        action: "PUSH_PAYLOAD_TRUNCATED",
        a2a_transfer: false,
        message: "Push payload exceeded 4096 bytes — body truncated",
        data: { category: payload.notificationCategory, entityId: payload.entityId, originalLength: JSON.stringify(payload).length },
      });
    }
    await webpush.sendNotification(subscription, serialized, {
      TTL: 60 * 60 * 6,
    });
    return { ok: true, expired: false, statusCode: 201 };
  } catch (error) {
    const statusCode =
      error && typeof error === "object" && "statusCode" in error
        ? Number((error as { statusCode?: unknown }).statusCode) || null
        : null;
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      expired: isExpired(statusCode),
      statusCode,
      error: message,
    };
  }
}

// Retry on 5xx or no statusCode (timeout / network blip). Don't retry on
// 4xx — those are correctly classified (404/410 = expired, others = bad
// request the push service won't accept on retry either).
function shouldRetryPush(result: PushSendResult): boolean {
  if (result.ok) return false;
  if (result.expired) return false; // 404/410 — terminal
  if (result.statusCode === null) return true; // timeout / no response
  return result.statusCode >= 500;
}

export async function sendPush(
  subscription: PushSubscriptionLike,
  payload: PushPayload,
): Promise<PushSendResult> {
  configure();
  const first = await sendPushOnce(subscription, payload);
  if (!shouldRetryPush(first)) return first;
  await new Promise((resolve) => setTimeout(resolve, 500));
  return sendPushOnce(subscription, payload);
}
