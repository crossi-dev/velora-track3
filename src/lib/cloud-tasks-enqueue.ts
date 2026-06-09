// Cloud Tasks enqueue helpers — payment confirm + cancel + whatsapp inbound workers.
//
// Onboarding nudge enqueue lives in cloud-tasks-onboarding-nudge.ts (split for
// file-size compliance — server/lib 300-line limit).
//
// Pattern: validate webhook → enqueue Cloud Task → return 200 immediately.
// The worker route processes the payload idempotently with Cloud Tasks retries.
//
// Auth: OIDC when CLOUD_TASKS_SA_EMAIL is set (canonical Google 2026).
// Shared-secret fallback (X-Velora-Task-Secret) for the 1-deploy migration window.
// Ref: https://cloud.google.com/tasks/docs/creating-http-target-tasks#token
// Ref: https://cloud.google.com/tasks/docs/creating-http-target-tasks
// Ref: https://cloud.google.com/tasks/docs/configuring-queues
// Stripe canonical pattern: https://stripe.com/docs/webhooks/best-practices#acknowledge-events-immediately

import { CloudTasksClient } from "@google-cloud/tasks";
import { cloudLog } from "@/lib/cloud-logger";

// Resolved at cold start — missing vars degrade to logged errors but do NOT
// crash the webhook handler (reconcile cron is the safety net per spec).
const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT ?? process.env.GCLOUD_PROJECT ?? "";
const LOCATION = process.env.CLOUD_TASKS_LOCATION ?? "southamerica-east1";
const CONFIRM_QUEUE = process.env.PAYMENT_CONFIRM_QUEUE ?? "velora-payment-confirm";
const CANCEL_QUEUE = process.env.PAYMENT_CANCEL_QUEUE ?? "velora-payment-cancel";
const WHATSAPP_INBOUND_QUEUE = process.env.WHATSAPP_INBOUND_QUEUE ?? "velora-whatsapp-inbound";
const APP_URL = process.env.VELORA_APP_URL ?? "";
// Shared with cron routes — already wired in Secret Manager.
const TASK_SECRET = process.env.CRON_SECRET ?? "";
// SA email for OIDC auth on the queue. When set, tasks include an OidcToken so
// Cloud Run can verify the caller is Cloud Tasks itself via Google-signed JWT.
// Ref: https://cloud.google.com/tasks/docs/creating-http-target-tasks#token
const TASKS_SA_EMAIL = process.env.CLOUD_TASKS_SA_EMAIL ?? "";

if (!PROJECT_ID) {
  cloudLog({
    severity: "WARNING",
    component: "System",
    action: "CLOUD_TASKS_NO_PROJECT",
    a2a_transfer: false,
    message:
      "GOOGLE_CLOUD_PROJECT not set — Cloud Tasks enqueue will fail. Set the env var in Cloud Run.",
  });
}

const tasksClient = new CloudTasksClient();

/**
 * Builds the httpRequest auth block.
 *
 * Auth paths are MUTUALLY EXCLUSIVE:
 *   OIDC (canonical, Google 2026): when CLOUD_TASKS_SA_EMAIL is set, attach an
 *     OidcToken so Cloud Run can verify the caller is Cloud Tasks itself via a
 *     Google-signed JWT. The shared secret is NOT included — it would appear in
 *     Cloud Tasks task metadata (visible to anyone with cloudtasks.tasks.get).
 *     Ref: https://cloud.google.com/tasks/docs/creating-http-target-tasks#token
 *   Shared secret (migration fallback): when CLOUD_TASKS_SA_EMAIL is unset,
 *     attach X-Velora-Task-Secret only. No OidcToken is configured on the queue.
 *
 * Never attach X-Velora-Task-Secret when OIDC is active — Cloud Tasks stores
 * task headers in plaintext metadata that any IAM principal with
 * cloudtasks.tasks.get can read. The shared secret must not leak there.
 * Ref: https://cloud.google.com/tasks/docs/reference/rest/v2/projects.locations.queues.tasks
 */
function buildAuthBlock(targetUrl: string): {
  oidcToken?: { serviceAccountEmail: string; audience: string };
  headers: Record<string, string>;
} {
  if (TASKS_SA_EMAIL) {
    // OIDC path: omit shared secret entirely to prevent metadata leakage.
    return {
      oidcToken: { serviceAccountEmail: TASKS_SA_EMAIL, audience: targetUrl },
      headers: { "Content-Type": "application/json" },
    };
  }
  // Shared-secret fallback path: no OidcToken configured on queue.
  return {
    headers: {
      "Content-Type": "application/json",
      "X-Velora-Task-Secret": TASK_SECRET,
    },
  };
}

export interface EnqueuePaymentConfirmInput {
  paymentIntentId: string;
  businessId: string;
}

/**
 * Enqueues a payment-confirm task to velora-payment-confirm.
 * Throws on enqueue failure — callers must catch and handle gracefully
 * (log ERROR, set reconcileFastTrack; reconcile cron is the safety net).
 *
 * Ref: https://cloud.google.com/tasks/docs/creating-http-target-tasks#creating_http_target_tasks
 */
export async function enqueuePaymentConfirm(
  input: EnqueuePaymentConfirmInput,
): Promise<void> {
  const parent = tasksClient.queuePath(PROJECT_ID, LOCATION, CONFIRM_QUEUE);
  const workerUrl = `${APP_URL}/api/internal/tasks/confirm-payment`;

  const payload: Record<string, string> = {
    paymentIntentId: input.paymentIntentId,
    businessId: input.businessId,
  };

  const body = Buffer.from(JSON.stringify(payload)).toString("base64");
  const { oidcToken, headers } = buildAuthBlock(workerUrl);

  // Named task for enqueue-time deduplication (Google Cloud Tasks 2026 canonical).
  // Same payment_id can trigger two back-to-back MP notifications; without a task
  // name, both enqueues succeed and the worker runs twice in parallel.
  // Named tasks give a free 1h–24h dedup window: the second createTask for the same
  // name returns ALREADY_EXISTS (gRPC status 6 / HTTP 409) which we treat as success.
  // The data-layer idempotency key "mp-confirm-{paymentIntentId}" is the final safety
  // net for races that slip through (e.g. task name expired before retry arrives).
  // Ref: https://cloud.google.com/tasks/docs/reference/rest/v2/projects.locations.queues.tasks/create
  //      "If a task with the same name already exists, the response will be an ALREADY_EXISTS error."
  const taskName = tasksClient.taskPath(
    PROJECT_ID,
    LOCATION,
    CONFIRM_QUEUE,
    `confirm-${input.paymentIntentId}`,
  );

  try {
    await tasksClient.createTask({
      parent,
      task: {
        name: taskName,
        httpRequest: {
          httpMethod: "POST" as const,
          url: workerUrl,
          headers,
          body,
          ...(oidcToken ? { oidcToken } : {}),
        },
      },
    });
  } catch (err: unknown) {
    // ALREADY_EXISTS (gRPC 6) = task with this name already queued or recently
    // completed — treat as success (idempotent enqueue).
    // Ref: https://cloud.google.com/tasks/docs/reference/rest/v2/projects.locations.queues.tasks/create
    const code = (err as { code?: number })?.code;
    if (code === 6) {
      cloudLog({
        severity: "INFO",
        component: "System",
        action: "CLOUD_TASKS_CONFIRM_ALREADY_EXISTS",
        a2a_transfer: false,
        message: `confirm task already queued for paymentIntentId=${input.paymentIntentId} — treated as success (idempotent enqueue)`,
        data: { paymentIntentId: input.paymentIntentId },
      });
      return;
    }
    throw err;
  }
}

export interface EnqueueWhatsappInboundInput {
  provider: "meta" | "twilio";
  businessId: string;
  from: string;          // customer phone in E.164
  text: string;          // inbound message text
  messageId: string;     // Meta/Twilio messageId — used for dedup
}

/**
 * Enqueues a WhatsApp inbound processing task to velora-whatsapp-inbound.
 *
 * Pattern: Webhook validates signature → enqueues task → returns 200 in <1s
 *   so Twilio/Meta never hit their ~15s webhook timeout.
 *
 * Industry-standard async webhook pattern:
 *   Twilio: https://www.twilio.com/en-us/blog/handle-long-running-asynchronous-operations-studio
 *     "It's not recommended to wait for long-running computations in the webhook directly,
 *      as this might cause a timeout."
 *   Stripe: https://stripe.com/docs/webhooks/best-practices#acknowledge-events-immediately
 *   Cloud Run + Cloud Tasks: https://cloud.google.com/run/docs/triggering/using-tasks
 *
 * Dedup: named task `wpp-inbound-{messageId}` gives free 1h-24h dedup window —
 *   if Twilio retries the same webhook (we 5xx'd), the second enqueue returns
 *   ALREADY_EXISTS (gRPC 6) which we treat as success.
 *   Ref: https://cloud.google.com/tasks/docs/reference/rest/v2/projects.locations.queues.tasks/create
 */
export async function enqueueWhatsappInbound(
  input: EnqueueWhatsappInboundInput,
): Promise<void> {
  const parent = tasksClient.queuePath(PROJECT_ID, LOCATION, WHATSAPP_INBOUND_QUEUE);
  const workerUrl = `${APP_URL}/api/internal/tasks/whatsapp-inbound`;

  const payload: Record<string, string> = {
    provider: input.provider,
    businessId: input.businessId,
    from: input.from,
    text: input.text,
    messageId: input.messageId,
  };

  const body = Buffer.from(JSON.stringify(payload)).toString("base64");
  const { oidcToken, headers } = buildAuthBlock(workerUrl);

  // Named task for idempotency: same messageId from Twilio/Meta retries collapse
  // into a single dispatch. Cloud Tasks ALREADY_EXISTS (gRPC 6) is treated as success.
  // Sanitize messageId to fit task name regex [A-Za-z0-9_-]+ (Twilio SIDs already match).
  const safeMessageId = input.messageId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 200);
  const taskName = tasksClient.taskPath(
    PROJECT_ID,
    LOCATION,
    WHATSAPP_INBOUND_QUEUE,
    `wpp-inbound-${safeMessageId}`,
  );

  try {
    await tasksClient.createTask({
      parent,
      task: {
        name: taskName,
        httpRequest: {
          httpMethod: "POST" as const,
          url: workerUrl,
          headers,
          body,
          ...(oidcToken ? { oidcToken } : {}),
        },
      },
    });
  } catch (err: unknown) {
    const code = (err as { code?: number })?.code;
    if (code === 6) {
      cloudLog({
        severity: "INFO",
        component: "WhatsApp",
        action: "CLOUD_TASKS_WPP_ALREADY_EXISTS",
        a2a_transfer: false,
        message: `wpp inbound task already queued for messageId=${input.messageId} — idempotent`,
        data: { messageId: input.messageId, businessId: input.businessId },
      });
      return;
    }
    throw err;
  }
}

export interface EnqueuePaymentCancelInput {
  paymentIntentId: string;
  businessId: string;
  idempotencyKey: string;
}

/**
 * Enqueues a payment-cancel task to velora-payment-cancel.
 * Throws on enqueue failure — callers should log ERROR and return 200 to the
 * webhook (the reconcile cron handles missed cancellations via REJECTED_STATUSES).
 *
 * Ref: https://cloud.google.com/tasks/docs/creating-http-target-tasks#creating_http_target_tasks
 */
export async function enqueuePaymentCancel(
  input: EnqueuePaymentCancelInput,
): Promise<void> {
  const parent = tasksClient.queuePath(PROJECT_ID, LOCATION, CANCEL_QUEUE);
  const workerUrl = `${APP_URL}/api/internal/tasks/cancel-payment`;

  const payload: Record<string, string> = {
    paymentIntentId: input.paymentIntentId,
    businessId: input.businessId,
    idempotencyKey: input.idempotencyKey,
  };

  const body = Buffer.from(JSON.stringify(payload)).toString("base64");
  const { oidcToken, headers } = buildAuthBlock(workerUrl);

  // Same pattern as enqueuePaymentConfirm — dedup at DATA layer, not task name.
  await tasksClient.createTask({
    parent,
    task: {
      httpRequest: {
        httpMethod: "POST" as const,
        url: workerUrl,
        headers,
        body,
        ...(oidcToken ? { oidcToken } : {}),
      },
    },
  });
}

