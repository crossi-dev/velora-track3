// Shared OIDC token verifier factories for Cloud Tasks and Pub/Sub workers.
//
// Cloud Tasks and Pub/Sub both inject Google-signed OIDC ID tokens, but their
// trust models differ:
//   - Cloud Tasks: pinned to CLOUD_TASKS_SA_EMAIL; warns at startup and at
//     runtime when the SA env var is unset (degrades gracefully).
//   - Pub/Sub: pinned to PUBSUB_SA_EMAIL; accepts silently when env var is
//     unset (Pub/Sub send-back-to-caller pattern — auth failure returns 200
//     to prevent infinite Pub/Sub retry loops).
//
// Ref: https://cloud.google.com/tasks/docs/creating-http-target-tasks#token
// Ref: https://cloud.google.com/pubsub/docs/push#authentication_and_authorization

import { timingSafeEqual } from "crypto";
import { OAuth2Client } from "google-auth-library";
import { cloudLog, type CloudLogComponent } from "@/lib/cloud-logger";

// One shared client — reuses connection pool across all verifiers.
const oidcClient = new OAuth2Client();

/**
 * Constant-time string comparison for shared-secret auth fallbacks.
 * Plain `===` short-circuits on the first differing byte, leaking a timing
 * oracle on secret values. OWASP mandates constant-time comparison for secrets.
 * Ref: https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html
 */
export function timingSafeEqualStr(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  try {
    const aBuf = Buffer.from(a, "utf8");
    const bBuf = Buffer.from(b, "utf8");
    if (aBuf.length !== bBuf.length) return false;
    return timingSafeEqual(aBuf, bBuf);
  } catch {
    return false;
  }
}

const APP_URL = process.env.VELORA_APP_URL ?? "";

// ── Cloud Tasks verifier ─────────────────────────────────────────────────────

export interface TasksOidcVerifierOptions {
  /** Absolute path suffix, e.g. "/api/internal/tasks/confirm-payment" */
  audiencePath: string;
  /**
   * Log component used in the "SA unverified" runtime warning.
   * Matches the component used in the caller's other cloudLog calls.
   */
  logComponent: CloudLogComponent;
  /**
   * Log action used in the "SA unverified" runtime warning.
   * Example: "TASK_CONFIRM_OIDC_SA_UNVERIFIED"
   */
  logAction: string;
  /**
   * Human-readable prefix for the startup warning message.
   * Example: "confirm-payment"
   */
  taskName: string;
}

/**
 * Returns an async function that verifies a Cloud Tasks OIDC token.
 * Behavior:
 *   - Verifies audience = VELORA_APP_URL + audiencePath.
 *   - When CLOUD_TASKS_SA_EMAIL is set, pins the token to that SA email.
 *   - When unset, accepts the token but emits a WARNING (degraded mode).
 *   - Emits a startup console.warn when SA env var is missing.
 */
export function makeTasksOidcVerifier(opts: TasksOidcVerifierOptions): (authHeader: string | null) => Promise<boolean> {
  const saEmail = process.env.CLOUD_TASKS_SA_EMAIL ?? "";

  if (!saEmail) {
    console.warn(
      `[STARTUP WARNING] ${opts.taskName}: CLOUD_TASKS_SA_EMAIL is not set — ` +
        "OIDC SA-pinning is disabled. Any Google-signed token for the correct " +
        "audience will be accepted. Set CLOUD_TASKS_SA_EMAIL in Cloud Run env.",
    );
  }

  return async function verifyOidcToken(authHeader: string | null): Promise<boolean> {
    if (!authHeader?.startsWith("Bearer ")) return false;
    const token = authHeader.slice(7);
    try {
      const ticket = await oidcClient.verifyIdToken({
        idToken: token,
        audience: `${APP_URL}${opts.audiencePath}`,
      });
      const payload = ticket.getPayload();
      if (!payload) return false;
      if (saEmail) {
        if (payload.email !== saEmail) return false;
      } else {
        // Fail-secure / deny-by-default (OWASP Authorization Cheat Sheet "Deny by
        // Default": https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html).
        // Without an SA email to pin, ANY GCP service account could mint a valid
        // Google-signed token for this audience, so OIDC must NOT be trusted here.
        // In SA-unset mode tasks are enqueued with the shared-secret header instead
        // of an OidcToken (see cloud-tasks-enqueue.ts buildAuthBlock), so legitimate
        // callers still authenticate via the secret path — rejecting OIDC is safe.
        cloudLog({
          severity: "ERROR",
          component: opts.logComponent,
          action: opts.logAction,
          a2a_transfer: false,
          message:
            `${opts.taskName}: OIDC rejected — CLOUD_TASKS_SA_EMAIL is not set, so the SA ` +
            "email cannot be pinned. Set it to enable OIDC auth; until then tasks use the shared secret.",
        });
        return false;
      }
      return true;
    } catch {
      return false;
    }
  };
}

// ── Pub/Sub verifier ─────────────────────────────────────────────────────────

export interface PubSubOidcVerifierOptions {
  /** Absolute path suffix, e.g. "/api/internal/dlq/payment-confirm" */
  audiencePath: string;
}

/**
 * Returns an async function that verifies a Pub/Sub push OIDC token.
 * Behavior:
 *   - Verifies audience = VELORA_APP_URL + audiencePath.
 *   - When PUBSUB_SA_EMAIL is set, pins the token to that SA email.
 *   - When unset, accepts the token silently (Pub/Sub degraded mode).
 *   - No startup warning (Pub/Sub SA is optional in dev environments).
 */
export function makePubSubOidcVerifier(opts: PubSubOidcVerifierOptions): (authHeader: string | null) => Promise<boolean> {
  const saEmail = process.env.PUBSUB_SA_EMAIL ?? "";

  return async function verifyPubSubToken(authHeader: string | null): Promise<boolean> {
    if (!authHeader?.startsWith("Bearer ")) return false;
    const token = authHeader.slice(7);
    try {
      const ticket = await oidcClient.verifyIdToken({
        idToken: token,
        audience: `${APP_URL}${opts.audiencePath}`,
      });
      const payload = ticket.getPayload();
      if (!payload) return false;
      if (saEmail && payload.email !== saEmail) return false;
      return true;
    } catch {
      return false;
    }
  };
}
