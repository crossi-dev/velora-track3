"use client";

import { useEffect, useRef } from "react";
import { Capacitor } from "@capacitor/core";
import { registerNativePush, listenNativePushReceived } from "@/lib/native-push-registration";
import { executeDashboardAction } from "../actions/executeDashboardAction";
import { isPushSupported, urlBase64ToBuffer, bufferToBase64 } from "./push-utils";

// v2: bump forces re-subscription after 2026-05-09 VAPID key rotation.
// Values written:
//   "granted"  — user said yes (or FCM registered). Does NOT gate re-subscription.
//   "denied"   — user said no. Gates both prompt and subscription (respect OS choice).
//   "default"  — user dismissed the prompt. Gates the prompt so we don't re-ask.
const STORAGE_KEY = "push-prompt-shown-v2";
// Canonical SW path — ServiceWorkerRegistrar owns registration of /api/service-worker.
// This hook uses navigator.serviceWorker.ready to reuse the already-registered SW
// instead of racing with a second register() call against /api/service-worker.

interface UsePushSubscriptionPromptArgs {
  // Becomes true once the user has at least one confirmed sale. Engagement
  // signal — we don't pester first-time visitors with permission prompts.
  hasConfirmedSale: boolean;
}

async function fetchVapidKey(): Promise<string | null> {
  try {
    const res = await fetch("/api/public/vapid-key", { cache: "no-store" });
    if (!res.ok) return null;
    const data = (await res.json()) as { publicKey?: string };
    return data.publicKey ?? null;
  } catch {
    return null;
  }
}

async function ensureWebSubscription(vapidPublicKey: string): Promise<void> {
  // Use the SW already registered by ServiceWorkerRegistrar (/api/service-worker).
  // Calling register() here again would race for controller ownership and could
  // bind the push subscription to the wrong SW.
  const registration = await navigator.serviceWorker.ready;

  let subscription = await registration.pushManager.getSubscription();

  if (subscription) {
    // Verify the subscription is usable by attempting to get its keys.
    // A subscription created with a different VAPID key will fail on the
    // push service level — unsubscribe and re-subscribe.
    const hasKeys = subscription.getKey("p256dh") && subscription.getKey("auth");
    if (!hasKeys) {
      await subscription.unsubscribe();
      subscription = null;
    }
  }

  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToBuffer(vapidPublicKey),
    });
  }

  const rawP256 = subscription.getKey("p256dh");
  const rawAuth = subscription.getKey("auth");
  if (!rawP256 || !rawAuth) {
    throw new Error("MISSING_SUBSCRIPTION_KEYS");
  }

  // Always POST — the server upserts on (businessId, endpoint), so posting
  // an already-known endpoint simply refreshes the row and clears `expired`.
  await executeDashboardAction("push-notifications.subscribe", {
    endpoint: subscription.endpoint,
    keys: {
      p256dh: bufferToBase64(rawP256),
      auth: bufferToBase64(rawAuth),
    },
  });
}

export function usePushSubscriptionPrompt({ hasConfirmedSale }: UsePushSubscriptionPromptArgs) {
  const triedRef = useRef(false);

  useEffect(() => {
    if (triedRef.current) return;
    if (!hasConfirmedSale) return;
    if (!isPushSupported()) return;
    if (typeof Notification === "undefined") return;

    // OS-level denial: respect forever — never prompt again, never subscribe.
    if (Notification.permission === "denied") {
      triedRef.current = true;
      try { window.localStorage.setItem(STORAGE_KEY, "denied"); } catch { /* ignore */ }
      return;
    }

    triedRef.current = true;

    (async () => {
      try {
        // ── NATIVE PATH: Capacitor Android (FCM) ─────────────────────────────
        if (Capacitor.isNativePlatform()) {
          // Self-healing: always attempt FCM registration. registerNativePush()
          // returns an existing token if already registered, so this is idempotent.
          const reg = await registerNativePush();
          if (!reg) return;

          const ok = await fetch("/api/push-notifications/fcm", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ fcmToken: reg.fcmToken, deviceLabel: "android-native" }),
          }).then((r) => r.ok).catch(() => false);

          if (ok) {
            try { window.localStorage.setItem(STORAGE_KEY, "granted"); } catch { /* ignore */ }
            // Register foreground + tap handlers after FCM token is saved.
            await listenNativePushReceived((_n) => {
              // Foreground: notification already shown by system tray — no extra UI needed.
            });
          }
          return;
        }

        // ── WEB PATH: standard Web Push ───────────────────────────────────────
        // Runtime VAPID key — fetched from /api/public/vapid-key instead of
        // NEXT_PUBLIC_ because Cloud Run --source deploy doesn't expose runtime
        // env vars to the build step.
        const vapidPublicKey = await fetchVapidKey();
        if (!vapidPublicKey) return;

        const permission = Notification.permission;

        if (permission === "granted") {
          // Self-healing path: user already said yes.
          // The STORAGE_KEY may say "granted" but the server row may be gone
          // (DB wipe, VAPID rotation, or subscription expiry). Always ensure a
          // live subscription exists — the server upserts, so this is safe.
          await ensureWebSubscription(vapidPublicKey);
          try { window.localStorage.setItem(STORAGE_KEY, "granted"); } catch { /* ignore */ }
          return;
        }

        // permission === "default" from here — may prompt.
        let shown: string | null = null;
        try { shown = window.localStorage.getItem(STORAGE_KEY); } catch { shown = null; }

        // "denied" value in storage means the OS permission IS denied but
        // Notification.permission returned "default" (e.g. permission was reset by
        // browser). Treat as undecided and allow re-prompt.
        if (shown === "granted" || shown === "default") {
          // We already prompted and the user either dismissed or we already
          // have a granted session — don't re-ask on this visit.
          return;
        }

        // First-time or permission-reset: show the browser permission prompt.
        const newPermission = await Notification.requestPermission();
        try { window.localStorage.setItem(STORAGE_KEY, newPermission); } catch { /* ignore */ }

        if (newPermission !== "granted") return;

        await ensureWebSubscription(vapidPublicKey);
      } catch (error) {
        // Failure is non-fatal — the cron simply has no subscription to send
        // to. The user can re-trigger by revisiting (triedRef resets per mount).
        console.warn("[push-prompt] subscribe failed", error);
      }
    })();
  }, [hasConfirmedSale]);
}
