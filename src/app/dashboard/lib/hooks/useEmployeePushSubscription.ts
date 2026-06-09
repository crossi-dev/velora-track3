"use client";

import { useEffect, useRef } from "react";
import { Capacitor } from "@capacitor/core";
import { registerNativePush, listenNativePushReceived } from "@/lib/native-push-registration";
import { isPushSupported, urlBase64ToBuffer, bufferToBase64 } from "./push-utils";

const STORAGE_KEY = "push-prompt-employee-v1";

interface UseEmployeePushSubscriptionArgs {
  enabled: boolean;
  /**
   * Engagement gate. The browser permission prompt only fires once the
   * employee has completed their first sale — by then the chat has
   * already shown the notification primer in the post-sale transition
   * message, so the OS dialog lands in context (no cold ask on mount).
   */
  hasFirstSale: boolean;
}

export function useEmployeePushSubscription({ enabled, hasFirstSale }: UseEmployeePushSubscriptionArgs) {
  const triedRef = useRef(false);

  useEffect(() => {
    if (!enabled || !hasFirstSale || triedRef.current) return;
    if (!isPushSupported()) return;
    if (typeof Notification === "undefined") return;
    if (Notification.permission === "denied") {
      triedRef.current = true;
      return;
    }
    let shown: string | null = null;
    try { shown = window.localStorage.getItem(STORAGE_KEY); } catch {}
    if (shown) return;

    triedRef.current = true;

    (async () => {
      try {
        // NATIVE PATH: Capacitor Android — FCM registration.
        if (Capacitor.isNativePlatform()) {
          const reg = await registerNativePush();
          if (!reg) return;
          await fetch("/api/push-notifications/fcm", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ fcmToken: reg.fcmToken, deviceLabel: "android-native-employee" }),
          });
          await listenNativePushReceived((_n) => { /* foreground handled by OS */ });
          window.localStorage.setItem(STORAGE_KEY, "granted");
          return;
        }

        // WEB PATH: standard Web Push (unchanged).
        const res = await fetch("/api/public/vapid-key", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { publicKey?: string };
        const vapidPublicKey = data.publicKey;
        if (!vapidPublicKey) return;

        const permission = await Notification.requestPermission();
        if (permission !== "granted") {
          window.localStorage.setItem(STORAGE_KEY, permission);
          return;
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
        if (!rawP256 || !rawAuth) return;

        await fetch("/api/push-notifications/employee-subscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            endpoint: subscription.endpoint,
            keys: { p256dh: bufferToBase64(rawP256), auth: bufferToBase64(rawAuth) },
          }),
        });

        window.localStorage.setItem(STORAGE_KEY, "granted");
      } catch (error) {
        console.warn("[employee-push] subscribe failed", error);
      }
    })();
  }, [enabled, hasFirstSale]);
}
