/* global process, setTimeout */
// Thin .mjs wrapper around `web-push` for use by Node scripts (e.g.
// scripts/smoke-push-e2e.mjs). Mirrors the classification logic in
// src/app/api/_lib/web-push.ts without duplicating the send path —
// the TypeScript module is not importable from plain .mjs scripts because
// Next.js path aliases and tsc are not available at script runtime.
//
// This file MUST stay in sync with web-push.ts:
//   - Same TTL (6 h)
//   - Same expiry classification (401 / 403 / 404 / 410 → expired)
//   - Same retry policy (5xx / no statusCode → one retry after 500 ms)

import webpush from "web-push";

let configured = false;

/**
 * Configure VAPID once. Reads from process.env:
 *   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_CONTACT_EMAIL
 * Throws VAPID_NOT_CONFIGURED if any is missing.
 */
function configure() {
  if (configured) return;
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const contact = process.env.VAPID_CONTACT_EMAIL;
  if (!publicKey || !privateKey || !contact) {
    throw new Error("VAPID_NOT_CONFIGURED: set VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_CONTACT_EMAIL");
  }
  const subject = contact.startsWith("mailto:") ? contact : `mailto:${contact}`;
  webpush.setVapidDetails(subject, publicKey, privateKey);
  configured = true;
}

// Keep in sync with src/app/api/_lib/web-push.ts isExpired()
// 401/403 = VAPID key mismatch (post-rotation stale subs); 404/410 = endpoint gone.
function isExpired(statusCode) {
  return statusCode === 401 || statusCode === 403 || statusCode === 404 || statusCode === 410;
}

async function sendOnce(subscription, payload) {
  try {
    await webpush.sendNotification(subscription, JSON.stringify(payload), {
      TTL: 60 * 60 * 6,
    });
    return { ok: true, expired: false, statusCode: 201 };
  } catch (err) {
    const statusCode =
      err && typeof err === "object" && "statusCode" in err
        ? Number(err.statusCode) || null
        : null;
    return {
      ok: false,
      expired: isExpired(statusCode),
      statusCode,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function shouldRetry(result) {
  if (result.ok) return false;
  if (result.expired) return false;
  if (result.statusCode === null) return true;
  return result.statusCode >= 500;
}

/**
 * Send a push notification to a single subscription.
 * Retries once on transient errors (5xx / network timeout).
 *
 * @param {{ endpoint: string, keys: { p256dh: string, auth: string } }} subscription
 * @param {{ title: string, body: string, url: string }} payload
 * @returns {Promise<{ ok: boolean, expired: boolean, statusCode: number|null, error?: string }>}
 */
export async function sendPush(subscription, payload) {
  configure();
  const first = await sendOnce(subscription, payload);
  if (!shouldRetry(first)) return first;
  await new Promise((r) => setTimeout(r, 500));
  return sendOnce(subscription, payload);
}
