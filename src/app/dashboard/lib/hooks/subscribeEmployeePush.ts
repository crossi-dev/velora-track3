"use client";

// Imperative employee push-subscribe helper — mirrors subscribeOwnerPush.ts
// but posts to /api/push-notifications/employee-subscribe (employee-gated).
// Called from the ChatRow "Reactivar" chip when role === "employee".

import { Capacitor } from "@capacitor/core";
import { registerNativePush, listenNativePushReceived } from "@/lib/native-push-registration";
import { isPushSupported, urlBase64ToBuffer, bufferToBase64 } from "./push-utils";

const STORAGE_KEY = "push-prompt-employee-v1";

export async function subscribeEmployeePush(): Promise<boolean> {
  // NATIVE PATH: Capacitor Android — register via FCM.
  if (Capacitor.isNativePlatform()) {
    try {
      const reg = await registerNativePush();
      if (!reg) return false;
      const ok = await fetch("/api/push-notifications/fcm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fcmToken: reg.fcmToken, deviceLabel: "android-native-employee" }),
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
    // Always unsubscribe first — reusing a pre-rotation subscription produces
    // 401s on the push service. Force a fresh subscription with the current key.
    const existing = await registration.pushManager.getSubscription();
    if (existing) await existing.unsubscribe();
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToBuffer(vapidPublicKey),
    });

    const rawP256 = subscription.getKey("p256dh");
    const rawAuth = subscription.getKey("auth");
    if (!rawP256 || !rawAuth) return false;

    const ok = await fetch("/api/push-notifications/employee-subscribe", {
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
    console.warn("[employee-push] subscribe failed", error);
    return false;
  }
}
