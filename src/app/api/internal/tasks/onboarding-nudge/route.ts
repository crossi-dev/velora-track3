// POST /api/internal/tasks/onboarding-nudge — Cloud Tasks worker.
//
// Receives a delayed task enqueued by sale-first-sale-primer.ts (attempt=0)
// or re-enqueued by this same worker (attempt=N+1) and sends one proactive
// integration nudge, then re-schedules if the user still needs more nudges.
//
// Replaces the hourly idle-fallback cron (velora-onboarding-integration-nudge).
// Pay-per-use (no standing cost). Bounded (ONBOARDING_NUDGE_MAX_ATTEMPTS, default 5).
//
// Auth: OIDC token (canonical, Google 2026) + shared-secret fallback.
// Mirrors: whatsapp-inbound/route.ts (same auth/queue-header/200-fast pattern).
//
// Industry-standard async worker pattern:
//   GCP:    https://cloud.google.com/run/docs/triggering/using-tasks
//   Stripe: https://stripe.com/docs/webhooks/best-practices#acknowledge-events-immediately
//
// Bounded re-schedule: if attempt+1 < MAX_ATTEMPTS AND user still has unconnected
// integrations → enqueue next task with next integration's window delay.
// Otherwise STOP — no more tasks for this user.
//
// Idempotency: named task `onboarding-nudge-{businessId}-attempt{N}-{slotDate}` in
// enqueueOnboardingNudge dedupes at enqueue time. maybeSendIntegrationNudge handles
// the P2002 insert dedup for the chat message itself.
//
// /api/internal/tasks is already in the middleware API_ALLOWLIST (verified — covers
// all routes under this path prefix).

import { NextRequest, NextResponse } from "next/server";
import { cloudLog, runWithTraceContext } from "@/lib/cloud-logger";
import { maybeSendIntegrationNudge } from "@/app/api/_lib/onboarding-integration-nudge";
import {
  pickDueIntegration,
  loadNudgeWindowState,
  hasUnconnectedIntegrations,
  getMaxAttempts,
  IDLE_WINDOWS_MS,
  INTEGRATION_PRIORITY,
} from "@/app/api/_lib/onboarding-nudge-windows";
import { enqueueOnboardingNudge } from "@/lib/cloud-tasks-onboarding-nudge";
import { getArgentinaDateString } from "@/app/dashboard/lib/today-summary";
import { verifyOidcToken } from "./_lib/verify-oidc-token";
import { timingSafeEqualStr } from "@/app/api/internal/_lib/oidc-verifiers";

// maxDuration: nudge send is DB-only (no LLM call) — 15s is generous.
export const maxDuration = 15;

const CLOUD_TASKS_QUEUE_HEADER = "x-cloudtasks-queuename";
const TASK_SECRET_HEADER = "x-velora-task-secret";
const EXPECTED_SECRET = process.env.CRON_SECRET ?? "";

interface TaskPayload {
  businessId: string;
  attempt: number;
}

function isTaskPayload(v: unknown): v is TaskPayload {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.businessId === "string" &&
    typeof o.attempt === "number" &&
    Number.isInteger(o.attempt) &&
    (o.attempt as number) >= 0
  );
}

async function handlePost(req: NextRequest): Promise<NextResponse> {
  if (process.env.PROACTIVE_ONBOARDING_ENABLED !== "true") {
    // Flag off — acknowledge the task so Cloud Tasks does not retry.
    return NextResponse.json({ ok: true, skipped: "flag_off" }, { status: 200 });
  }

  const authHeader = req.headers.get("authorization");
  const secret = req.headers.get(TASK_SECRET_HEADER) ?? "";
  const queueHeader = req.headers.get(CLOUD_TASKS_QUEUE_HEADER) ?? "";

  const oidcValid = await verifyOidcToken(authHeader);
  const secretValid = timingSafeEqualStr(secret, EXPECTED_SECRET);

  if (!oidcValid && !secretValid) {
    cloudLog({
      severity: "CRITICAL",
      component: "System",
      action: "TASK_ONBOARDING_NUDGE_AUTH_FAILED",
      a2a_transfer: false,
      message: "onboarding-nudge task auth failed — neither OIDC nor shared secret matched",
    });
    return NextResponse.json({ ok: false, error: "auth_failed" }, { status: 403 });
  }

  // Defense-in-depth: Cloud Tasks injects X-CloudTasks-QueueName on every delivery.
  // Mirrors: whatsapp-inbound/route.ts (same pattern, fail-closed on 400).
  // Ref: https://cloud.google.com/tasks/docs/creating-http-target-tasks#handler
  if (!queueHeader) {
    cloudLog({
      severity: "WARNING",
      component: "System",
      action: "TASK_ONBOARDING_NUDGE_NO_QUEUE_HEADER",
      a2a_transfer: false,
      message: "onboarding-nudge: missing X-CloudTasks-QueueName header — rejecting (fail-closed)",
    });
    return NextResponse.json({ ok: false, error: "missing_queue_header" }, { status: 400 });
  }

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  if (!isTaskPayload(payload)) {
    return NextResponse.json({ ok: false, error: "invalid_payload" }, { status: 400 });
  }

  const { businessId, attempt } = payload;
  const maxAttempts = getMaxAttempts();

  cloudLog({
    severity: "INFO",
    component: "System",
    action: "TASK_ONBOARDING_NUDGE_START",
    a2a_transfer: false,
    message: `onboarding-nudge task: businessId=${businessId} attempt=${attempt}`,
    data: { businessId, attempt, maxAttempts },
  });

  try {
    // 1. Load fresh window state from DB.
    const state = await loadNudgeWindowState(businessId);
    if (!state) {
      cloudLog({
        severity: "WARNING",
        component: "System",
        action: "TASK_ONBOARDING_NUDGE_NO_BUSINESS",
        a2a_transfer: false,
        message: `onboarding-nudge: business not found — dropping task`,
        data: { businessId, attempt },
      });
      // Return 200 so Cloud Tasks does not retry a non-existent business.
      return NextResponse.json({ ok: true, skipped: "no_business" }, { status: 200 });
    }

    // 2. Pick the highest-priority due integration (applies the ART-day cap).
    const integration = pickDueIntegration(state, Date.now());

    if (integration) {
      // 3. Send the nudge (idempotent, TOCTOU-safe via maybeSendIntegrationNudge).
      const result = await maybeSendIntegrationNudge({ businessId, integration });
      cloudLog({
        severity: "INFO",
        component: "System",
        action: "TASK_ONBOARDING_NUDGE_SEND_RESULT",
        a2a_transfer: false,
        message: `onboarding-nudge send result: ${result}`,
        data: { businessId, attempt, integration, result },
      });

      // Fix 1: internal_error is a transient DB failure — do NOT advance the attempt
      // counter or enqueue the next task. Return 500 so Cloud Tasks retries the SAME
      // task (same attempt number) using its queue retry config, preserving the budget.
      // All other results (sent, duplicate, skip_*) proceed to the re-schedule logic.
      if (result === "internal_error") {
        cloudLog({
          severity: "WARNING",
          component: "System",
          action: "TASK_ONBOARDING_NUDGE_TRANSIENT_ERROR",
          a2a_transfer: false,
          message: `onboarding-nudge: internal_error from nudge send — returning 500 for Cloud Tasks retry (attempt ${attempt} not consumed)`,
          data: { businessId, attempt },
        });
        return NextResponse.json({ ok: false, error: "transient_nudge_error" }, { status: 500 });
      }
    }

    // 4. Bounded re-schedule: if under MAX_ATTEMPTS and user still stuck, chain next task.
    const nextAttempt = attempt + 1;
    if (nextAttempt < maxAttempts) {
      const stillStuck = await hasUnconnectedIntegrations(businessId);
      if (stillStuck) {
        // Pick delay for the next window. We walk INTEGRATION_PRIORITY in order to
        // find the next undelivered integration and use its window as the delay.
        // If none remains (all connected), hasUnconnectedIntegrations returned false
        // so we never reach here. Default to the last window (arca = 72h) as a
        // conservative safe-guard.
        const nextWindowMs = pickNextWindowDelay(state, Date.now());
        const slotDate = getArgentinaDateString(Date.now());
        // Fix 2: await the enqueue — prevents the container recycling on scale-to-zero
        // before the Cloud Tasks API call completes (the helper never throws).
        await enqueueOnboardingNudge({
          businessId,
          attempt: nextAttempt,
          delaySeconds: Math.floor(nextWindowMs / 1000),
          slotDate,
        });
        cloudLog({
          severity: "INFO",
          component: "System",
          action: "TASK_ONBOARDING_NUDGE_RESCHEDULED",
          a2a_transfer: false,
          message: `onboarding-nudge re-scheduled: attempt=${nextAttempt} delay=${nextWindowMs / 3600000}h`,
          data: { businessId, nextAttempt, delayMs: nextWindowMs },
        });
      } else {
        cloudLog({
          severity: "INFO",
          component: "System",
          action: "TASK_ONBOARDING_NUDGE_CHAIN_COMPLETE",
          a2a_transfer: false,
          message: `onboarding-nudge chain complete — all integrations connected`,
          data: { businessId, attempt },
        });
      }
    } else {
      cloudLog({
        severity: "INFO",
        component: "System",
        action: "TASK_ONBOARDING_NUDGE_MAX_ATTEMPTS",
        a2a_transfer: false,
        message: `onboarding-nudge reached max attempts (${maxAttempts}) — stopping chain`,
        data: { businessId, attempt, maxAttempts },
      });
    }

    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (err) {
    cloudLog({
      severity: "ERROR",
      component: "System",
      action: "TASK_ONBOARDING_NUDGE_ERROR",
      a2a_transfer: false,
      message: `onboarding-nudge task failed: ${err instanceof Error ? err.message : String(err)}`,
      data: {
        businessId,
        attempt,
        errName: err instanceof Error ? err.name : typeof err,
        errStack: err instanceof Error ? err.stack?.slice(0, 2000) : undefined,
      },
    });
    // 500 → Cloud Tasks retries with configured backoff.
    return NextResponse.json({ ok: false, error: "process_failed" }, { status: 500 });
  }
}

/**
 * Picks the delay (ms) for the NEXT re-schedule attempt.
 *
 * Walks INTEGRATION_PRIORITY in order: the first integration whose window has
 * NOT yet elapsed since firstSaleAt becomes the next wait target.
 * Falls back to the ARCA 72h window (the longest) as a safe default if all
 * windows already elapsed (the next nudge will arrive and the pickDueIntegration
 * check will handle the cap / already-connected cases).
 */
function pickNextWindowDelay(state: { firstSaleAt: Date | null }, nowMs: number): number {
  if (!state.firstSaleAt) return IDLE_WINDOWS_MS.mp; // safe default — 24h
  const anchorMs = state.firstSaleAt.getTime();

  for (const integration of INTEGRATION_PRIORITY) {
    const windowMs = IDLE_WINDOWS_MS[integration];
    const elapsedMs = nowMs - anchorMs;
    if (elapsedMs < windowMs) {
      // This window hasn't elapsed yet — schedule for the remaining gap.
      return windowMs - elapsedMs;
    }
  }
  // All windows elapsed — re-schedule after 24h so the worker can check
  // if any late-connecting integration still needs a nudge.
  return 24 * 60 * 60 * 1000;
}

export function POST(req: NextRequest): Promise<NextResponse> {
  return runWithTraceContext(req.headers, () => handlePost(req));
}
