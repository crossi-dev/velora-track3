// Cloud Tasks enqueue helper — onboarding nudge worker.
//
// Split from cloud-tasks-enqueue.ts to stay within the server/lib 300-line limit.
// Mirrors the same OIDC auth + named-task dedup + scheduleTime pattern used by
// enqueuePaymentConfirm in cloud-tasks-enqueue.ts.
//
// scheduleTime: Cloud Tasks native delayed scheduling via google.protobuf.Timestamp.
// Max scheduling horizon: 30 days. Our windows are ≤72h — well within limit.
// Ref: https://cloud.google.com/tasks/docs/reference/rest/v2/projects.locations.queues.tasks#Task
//   "scheduleTime: The time when the task is scheduled to be attempted or retried.
//    task.schedule_time can be set to a future time up to 30 days in advance."
//
// Queue must be created in Cloud Tasks before enabling PROACTIVE_ONBOARDING_ENABLED=true.
// Region: southamerica-east1 (same as all other Velora queues). Create with a BOUNDED
// retry policy so a persistent DB failure (internal_error → HTTP 500) cannot loop on the
// Cloud Tasks default of 100 attempts:
//   gcloud tasks queues create velora-onboarding-nudge --location=southamerica-east1 \
//     --max-attempts=5 --min-backoff=60s --max-backoff=3600s --max-retry-duration=3600s
// (mirrors the velora-whatsapp-inbound fix from 100→5; see CUSTOMER_AGENT_AUDIT_2026-05-29).

import { CloudTasksClient } from "@google-cloud/tasks";
import { cloudLog } from "@/lib/cloud-logger";

const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT ?? process.env.GCLOUD_PROJECT ?? "";
const LOCATION = process.env.CLOUD_TASKS_LOCATION ?? "southamerica-east1";
const APP_URL = process.env.VELORA_APP_URL ?? "";
const TASK_SECRET = process.env.CRON_SECRET ?? "";
const TASKS_SA_EMAIL = process.env.CLOUD_TASKS_SA_EMAIL ?? "";

// Queue name constant — exported so callers can reference it in log messages.
export const ONBOARDING_NUDGE_QUEUE =
  process.env.ONBOARDING_NUDGE_QUEUE ?? "velora-onboarding-nudge";

// Fix 4: emit cold-start WARNING when PROJECT_ID is missing — mirrors cloud-tasks-enqueue.ts.
// Ref: https://cloud.google.com/run/docs/configuring/services/environment-variables
if (!PROJECT_ID) {
  cloudLog({
    severity: "WARNING",
    component: "System",
    action: "CLOUD_TASKS_NO_PROJECT",
    a2a_transfer: false,
    message:
      "GOOGLE_CLOUD_PROJECT not set — Cloud Tasks onboarding nudge enqueue will fail. Set the env var in Cloud Run.",
  });
}

const tasksClient = new CloudTasksClient();

/** Builds the httpRequest auth block — mirrors buildAuthBlock in cloud-tasks-enqueue.ts. */
function buildAuthBlock(targetUrl: string): {
  oidcToken?: { serviceAccountEmail: string; audience: string };
  headers: Record<string, string>;
} {
  if (TASKS_SA_EMAIL) {
    return {
      oidcToken: { serviceAccountEmail: TASKS_SA_EMAIL, audience: targetUrl },
      headers: { "Content-Type": "application/json" },
    };
  }
  return {
    headers: {
      "Content-Type": "application/json",
      "X-Velora-Task-Secret": TASK_SECRET,
    },
  };
}

export interface EnqueueOnboardingNudgeInput {
  businessId: string;
  /** Zero-based attempt counter (0 = first nudge after first sale). */
  attempt: number;
  /**
   * Seconds from now until the task should be delivered.
   * Cloud Tasks scheduleTime (google.protobuf.Timestamp). Max 30 days (2592000s).
   * Our windows are ≤72h (259200s) — well within limit.
   */
  delaySeconds: number;
  /**
   * ART calendar day (YYYY-MM-DD) for the named-task dedup slot.
   * Encoded in the task name so retries within the same day collapse via
   * named-task ALREADY_EXISTS (gRPC 6).
   */
  slotDate: string;
}

/**
 * Enqueues a delayed onboarding-nudge task to velora-onboarding-nudge.
 *
 * Pattern: fire-and-forget from sale-first-sale-primer (attempt=0) or from
 * the nudge worker itself for re-schedule (attempt=N+1).
 * Uses Cloud Tasks native scheduleTime — no custom setTimeout or cron needed.
 *
 * Named task: `onboarding-nudge-{businessId}-attempt{attempt}-{slotDate}`
 *   → dedupes enqueue races (ALREADY_EXISTS = no-op, treated as success).
 *
 * NEVER throws — callers fire-and-forget. All errors absorbed and logged.
 * Ref: https://cloud.google.com/tasks/docs/creating-http-target-tasks
 */
export async function enqueueOnboardingNudge(
  input: EnqueueOnboardingNudgeInput,
): Promise<void> {
  const parent = tasksClient.queuePath(PROJECT_ID, LOCATION, ONBOARDING_NUDGE_QUEUE);
  const workerUrl = `${APP_URL}/api/internal/tasks/onboarding-nudge`;

  const payload = { businessId: input.businessId, attempt: input.attempt };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64");
  const { oidcToken, headers } = buildAuthBlock(workerUrl);

  // scheduleTime: seconds since Unix epoch when Cloud Tasks should deliver this task.
  // Ref: https://cloud.google.com/tasks/docs/reference/rest/v2/projects.locations.queues.tasks#Task
  const scheduleTimeSeconds = Math.floor((Date.now() + input.delaySeconds * 1000) / 1000);

  // Named task — businessId uses CUID [a-z0-9]+, slotDate is YYYY-MM-DD.
  const safeBusinessId = input.businessId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80);
  const taskName = tasksClient.taskPath(
    PROJECT_ID,
    LOCATION,
    ONBOARDING_NUDGE_QUEUE,
    `onboarding-nudge-${safeBusinessId}-attempt${input.attempt}-${input.slotDate}`,
  );

  try {
    await tasksClient.createTask({
      parent,
      task: {
        name: taskName,
        scheduleTime: { seconds: scheduleTimeSeconds },
        httpRequest: {
          httpMethod: "POST" as const,
          url: workerUrl,
          headers,
          body,
          ...(oidcToken ? { oidcToken } : {}),
        },
      },
    });
    cloudLog({
      severity: "INFO",
      component: "System",
      action: "ONBOARDING_NUDGE_TASK_ENQUEUED",
      a2a_transfer: false,
      message: `Onboarding nudge task enqueued: attempt=${input.attempt}, delay=${input.delaySeconds}s`,
      data: {
        businessId: input.businessId,
        attempt: input.attempt,
        delaySeconds: input.delaySeconds,
        slotDate: input.slotDate,
      },
    });
  } catch (err: unknown) {
    // ALREADY_EXISTS (gRPC 6) — same slot already queued. Treat as success (idempotent enqueue).
    // Ref: https://cloud.google.com/tasks/docs/reference/rest/v2/projects.locations.queues.tasks/create
    const code = (err as { code?: number })?.code;
    if (code === 6) {
      cloudLog({
        severity: "INFO",
        component: "System",
        action: "ONBOARDING_NUDGE_TASK_ALREADY_EXISTS",
        a2a_transfer: false,
        message: `Onboarding nudge already queued (idempotent): attempt=${input.attempt}`,
        data: { businessId: input.businessId, attempt: input.attempt, slotDate: input.slotDate },
      });
      return;
    }
    // Non-dedup error: log but never throw — caller fires-and-forgets.
    cloudLog({
      severity: "ERROR",
      component: "System",
      action: "ONBOARDING_NUDGE_TASK_ENQUEUE_FAILED",
      a2a_transfer: false,
      message: `Failed to enqueue onboarding nudge: ${err instanceof Error ? err.message : String(err)}`,
      data: {
        businessId: input.businessId,
        attempt: input.attempt,
        delaySeconds: input.delaySeconds,
      },
    });
  }
}
