"use client";

// Imperative owner push-subscribe helper invoked by the action chip
// "Sí, avisame" emitted post-T6 by the supervisor. Mirrors the engagement
// gate of useEmployeePushSubscription but runs on tap (not on mount), so
// the OS dialog lands right when the owner expressed intent.
//
// Returns true if the browser ended up granting permission AND the
// subscription was POSTed to /api/push-notifications/subscribe; false
// otherwise (denied, unsupported, network error). The chat-side caller
// uses the boolean to decide whether to send an "ok" follow-up message.

// Must match usePushSubscriptionPrompt.ts so the mount-time check sees the
// key the chip handler wrote and doesn't re-prompt the owner.
const STORAGE_KEY = "push-prompt-shown-v2";

import { Capacitor } from "@capacitor/core";
import { registerNativePush, listenNativePushReceived } from "@/lib/native-push-registration";
import { isPushSupported, urlBase64ToBuffer, bufferToBase64 } from "./push-utils";

export async function subscribeOwnerPush(): Promise<boolean> {
  // NATIVE PATH: Capacitor Android — register via FCM instead of Web Push.
  if (Capacitor.isNativePlatform()) {
    try {
      const reg = await registerNativePush();
      if (!reg) return false;
      const ok = await fetch("/api/push-notifications/fcm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fcmToken: reg.fcmToken, deviceLabel: "android-native" }),
      }).then((r) => r.ok).catch(() => false);
      if (ok) {
        try { window.localStorage.setItem(STORAGE_KEY, "granted"); } catch {}
        await listenNativePushReceived((_n) => { /* foreground handled by OS */ });
      }
      return ok;
    } catch {
      return false;
    }
  }

  // WEB PATH: standard Web Push (unchanged).
  if (!isPushSupported()) return false;
  if (typeof Notification === "undefined") return false;
  if (Notification.permission === "denied") return false;

  try {
    const res = await fetch("/api/public/vapid-key", { cache: "no-store" });
    if (!res.ok) return false;
    const data = (await res.json()) as { publicKey?: string };
    const vapidPublicKey = data.publicKey;
    if (!vapidPublicKey) return false;

    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      try { window.localStorage.setItem(STORAGE_KEY, permission); } catch {}
      return false;
    }

    const registration = await navigator.serviceWorker.ready;
    // B2: always unsubscribe first — reusing an existing subscription after a
    // VAPID key rotation produces 401s on the push service. Force a fresh one.
    const existing = await registration.pushManager.getSubscription();
    if (existing) await existing.unsubscribe();
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToBuffer(vapidPublicKey),
    });

    const rawP256 = subscription.getKey("p256dh");
    const rawAuth = subscription.getKey("auth");
    if (!rawP256 || !rawAuth) return false;

    const ok = await fetch("/api/push-notifications/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        endpoint: subscription.endpoint,
        keys: { p256dh: bufferToBase64(rawP256), auth: bufferToBase64(rawAuth) },
      }),
    }).then((r) => r.ok).catch(() => false);

    if (ok) {
      try { window.localStorage.setItem(STORAGE_KEY, "granted"); } catch {}
    }
    return ok;
  } catch (error) {
    console.warn("[owner-push] subscribe failed", error);
    return false;
  }
}
