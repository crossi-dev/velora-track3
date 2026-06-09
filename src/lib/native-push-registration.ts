"use client";

// Native push registration for Capacitor Android via FCM.
// ONLY runs on native platform — returns null on web (browser handles Web Push).
// All errors are caught; callers must handle null gracefully.

import { Capacitor } from "@capacitor/core";

export interface NativePushRegistration {
  fcmToken: string;
}

/**
 * Requests FCM push permission and returns the FCM registration token.
 * Returns null if:
 *  - Not running on a native Capacitor platform (web browser)
 *  - User denies permission
 *  - google-services.json missing (FCM plugin throws at runtime)
 *  - Any other error
 *
 * Timeout: 10 seconds waiting for the registration event.
 */
export async function registerNativePush(): Promise<NativePushRegistration | null> {
  if (!Capacitor.isNativePlatform()) return null;

  try {
    // Dynamic import — @capacitor/push-notifications is only meaningful on native.
    const { PushNotifications } = await import("@capacitor/push-notifications");

    const perm = await PushNotifications.requestPermissions();
    if (perm.receive !== "granted") return null;

    await PushNotifications.register();

    return new Promise<NativePushRegistration | null>((resolve) => {
      let settled = false;
      function settle(value: NativePushRegistration | null) {
        if (settled) return;
        settled = true;
        // Clean up both listeners before resolving to avoid accumulating
        // stale handlers across multiple registration attempts.
        registrationListener.then((h) => h.remove()).catch(() => {});
        errorListener.then((h) => h.remove()).catch(() => {});
        resolve(value);
      }

      const registrationListener = PushNotifications.addListener(
        "registration",
        (token) => {
          settle({ fcmToken: token.value });
        },
      );

      const errorListener = PushNotifications.addListener(
        "registrationError",
        (err) => {
          console.warn("[native-push] registration error", err);
          settle(null);
        },
      );

      // Timeout guard: FCM registration hangs if google-services.json is absent
      // or network is unreachable.
      setTimeout(() => {
        settle(null);
      }, 10_000);
    });
  } catch {
    // google-services.json absent → plugin throws on Android at runtime.
    return null;
  }
}

export interface NativePushNotification {
  title?: string;
  body?: string;
  data?: unknown;
}

/**
 * Registers foreground and tap listeners for native push notifications.
 * No-op on web.
 */
export async function listenNativePushReceived(
  handler: (notification: NativePushNotification) => void,
): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;

  try {
    const { PushNotifications } = await import("@capacitor/push-notifications");

    // Await each addListener so errors surface instead of being silently dropped.
    await PushNotifications.addListener("pushNotificationReceived", (n) => {
      handler({ title: n.title, body: n.body, data: n.data });
    });

    await PushNotifications.addListener("pushNotificationActionPerformed", () => {
      // Navigate to chat when the user taps the system-tray notification.
      // Use a query param so DashboardPage can select the chat tab at mount
      // even on a cold start, avoiding the SW postMessage race.
      if (typeof window !== "undefined") {
        window.location.href = "/dashboard?openTab=main&from=push";
      }
    });
  } catch {
    // Silently noop — native platform without FCM configured.
  }
}
