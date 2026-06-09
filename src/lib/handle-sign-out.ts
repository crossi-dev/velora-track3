"use client";

import { signOut } from "next-auth/react";
import { isCapacitor } from "@/lib/capacitor-helpers";
import { clearNativeToken } from "@/lib/native-fetch-interceptor";

// Native owner auth uses an HMAC token, not a NextAuth session cookie —
// signOut() has nothing to clear and the post-signout redirect never lands.
// Clear the token and hard-navigate ourselves. Web keeps the standard signOut.
export async function handleSignOut(): Promise<void> {
  if (typeof window !== "undefined") {
    try {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const key = localStorage.key(i);
        if (key?.startsWith("velora")) localStorage.removeItem(key);
      }
    } catch { /* WebView storage permissions can throw — non-fatal */ }
  }

  // Remove push subscription so the server stops delivering notifications to
  // a device that has signed out. A lingering endpoint can leak pushes to the
  // next account that signs in on the same device.
  // Errors are caught silently — sign-out must succeed even if unsubscribe fails.
  if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = await reg?.pushManager.getSubscription();
      if (sub) {
        // 1. Remove from DB first so the server stops delivering immediately.
        try {
          await fetch("/api/push-notifications/unsubscribe", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ endpoint: sub.endpoint }),
          });
        } catch (err) {
          console.error("[handleSignOut] server push unsubscribe failed", err);
        }
        // 2. Invalidate the browser-level subscription.
        await sub.unsubscribe();
      }
    } catch (err) {
      console.error("[handleSignOut] push unsubscribe failed", err);
    }
  }

  // Preferences plugin may be unregistered in older APKs (capacitor.plugins.json
  // didn't include @capacitor/preferences before 2026-05-12). A reject here used
  // to swallow silently via the caller's `void`, leaving the user stuck on the
  // dashboard. Isolate the failure so the redirect always runs.
  try { await clearNativeToken(); } catch (err) { console.error("[handleSignOut] clearNativeToken failed", err); }
  if (isCapacitor()) {
    window.location.href = "/";
    return;
  }
  await signOut({ callbackUrl: "/" });
}
