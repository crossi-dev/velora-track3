// Firebase Admin SDK — lazy-init singleton.
// Initialization is gated on FIREBASE_SERVICE_ACCOUNT_JSON env var.
// If the env var is absent (e.g. owner hasn't uploaded the service account yet),
// getFirebaseAdmin() returns null and all callers must degrade gracefully.
// This module NEVER throws — every error is swallowed and logged.

import { cloudLog } from "@/lib/cloud-logger";

// Dynamic import to avoid bundling the heavy SDK at module-parse time.
// The import() call is executed at most once per process lifetime.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let adminInstance: any = null;
let initialized = false;
let initAttempted = false;

async function getAdmin() {
  if (initialized) return adminInstance;
  if (initAttempted) return null; // Previous attempt failed — don't retry in same process.
  initAttempted = true;

  const json = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  const projectId = process.env.FIREBASE_PROJECT_ID;

  // Two init paths supported:
  //   1. Explicit service account JSON in env (FIREBASE_SERVICE_ACCOUNT_JSON).
  //      Use this for local dev, or when the Firebase project is unrelated to
  //      the Cloud Run service account's GCP project.
  //   2. Application Default Credentials + FIREBASE_PROJECT_ID. Used in Cloud
  //      Run: the runtime service account has been granted roles/firebase.admin
  //      on the Firebase project, so admin SDK initializes without any secret
  //      file. This avoids storing/rotating private keys.
  if (!json && !projectId) {
    cloudLog({
      severity: "WARNING",
      component: "System",
      action: "FCM_NOT_CONFIGURED",
      a2a_transfer: false,
      message: "Neither FIREBASE_SERVICE_ACCOUNT_JSON nor FIREBASE_PROJECT_ID set — FCM push channel unavailable",
      data: {},
    });
    return null;
  }

  try {
    // Dynamic import keeps firebase-admin out of the main bundle for web pages.
    const admin = await import("firebase-admin");

    if (admin.apps.length === 0) {
      if (json) {
        // Path 1: explicit service account JSON.
        let cred: object;
        try {
          cred = JSON.parse(json);
        } catch {
          cloudLog({
            severity: "ERROR",
            component: "System",
            action: "FCM_INIT_FAILED",
            a2a_transfer: false,
            message: "FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON",
            data: {},
          });
          return null;
        }
        admin.initializeApp({
          credential: admin.credential.cert(cred as Parameters<typeof admin.credential.cert>[0]),
        });
      } else {
        // Path 2: ADC + projectId. ADC picks the Cloud Run runtime service
        // account automatically; projectId targets the Firebase project that
        // SA has been granted access to.
        admin.initializeApp({
          credential: admin.credential.applicationDefault(),
          projectId,
        });
      }
    }

    adminInstance = admin;
    initialized = true;
    return admin;
  } catch (err) {
    cloudLog({
      severity: "ERROR",
      component: "System",
      action: "FCM_INIT_FAILED",
      a2a_transfer: false,
      message: "firebase-admin initializeApp threw",
      data: { error: err instanceof Error ? err.message : String(err) },
    });
    return null;
  }
}

export interface FcmSendResult {
  ok: boolean;
  reason?: string;
}

/**
 * Sends a push notification via Firebase Cloud Messaging.
 * Returns { ok: false, reason: "firebase-not-configured" } when the admin SDK
 * is not available — callers must handle gracefully (log + skip, never throw).
 *
 * Returns { ok: false, reason: "invalid-token" } when FCM rejects the token as
 * unregistered — caller should mark the subscription expired in the DB.
 */
export async function sendFcmNotification(
  token: string,
  title: string,
  body: string,
  data?: Record<string, string>,
): Promise<FcmSendResult> {
  const admin = await getAdmin();
  if (!admin) return { ok: false, reason: "firebase-not-configured" };

  try {
    await admin.messaging().send({
      token,
      notification: { title, body },
      ...(data ? { data } : {}),
      android: {
        // High-priority delivery so the notification arrives in the system tray
        // immediately (vs. normal-priority which can be deferred by Doze mode).
        priority: "high",
        notification: {
          // Channel must exist on the device. @capacitor/push-notifications
          // creates a default channel named "default" on register.
          channelId: "default",
          sound: "default",
        },
      },
    });
    return { ok: true };
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code ?? "";
    if (
      code === "messaging/registration-token-not-registered" ||
      code === "messaging/invalid-registration-token"
    ) {
      // Terminal — token is no longer valid (app uninstalled / re-installed).
      // Caller must delete or expire the subscription row.
      return { ok: false, reason: "invalid-token" };
    }
    cloudLog({
      severity: "WARNING",
      component: "System",
      action: "FCM_SEND_FAILED",
      a2a_transfer: false,
      message: "FCM send threw unexpectedly",
      data: { code, error: err instanceof Error ? err.message : String(err) },
    });
    return { ok: false, reason: code || "unknown" };
  }
}
