// POST /api/internal/tasks/cancel-payment — Cloud Tasks worker for PI cancellation.
//
// Mirrors the confirm worker pattern: receives the cancel payload enqueued by the
// MP webhook handler and calls cancelPaymentIntentUseCase synchronously.
//
// Auth: OIDC token (canonical Google 2026) with shared-secret fallback.
// Ref: https://cloud.google.com/tasks/docs/creating-http-target-tasks#token
//
// Retry behaviour: return 500 for transient errors → Cloud Tasks retries.
// Return 200 for terminal states (already cancelled, not found) → no retry.
// Ref: https://cloud.google.com/tasks/docs/reference/rest/v2/projects.locations.queues#RetryConfig
//
// Idempotency: cancelPaymentIntentUseCase uses beginIdempotentMutation with the
// idempotencyKey supplied in the payload — safe to run multiple times.

import { NextRequest, NextResponse } from "next/server";
import { cloudLog, runWithTraceContext } from "@/lib/cloud-logger";
import { cancelPaymentIntentUseCase } from "@/app/api/payment-intents/_lib/cancel-payment-intent-use-case";
import { SYSTEM_ACTOR_MP_WEBHOOK } from "@/lib/system-actors";
import { makeTasksOidcVerifier, timingSafeEqualStr } from "@/app/api/internal/_lib/oidc-verifiers";

const CLOUD_TASKS_QUEUE_HEADER = "x-cloudtasks-queuename";
const TASK_SECRET_HEADER = "x-velora-task-secret";
const EXPECTED_SECRET = process.env.CRON_SECRET ?? "";

const verifyOidcToken = makeTasksOidcVerifier({
  audiencePath: "/api/internal/tasks/cancel-payment",
  logComponent: "System",
  logAction: "TASK_CANCEL_OIDC_SA_UNVERIFIED",
  taskName: "cancel-payment",
});

interface TaskPayload {
  paymentIntentId: string;
  businessId: string;
  idempotencyKey: string;
}

function isTaskPayload(v: unknown): v is TaskPayload {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.paymentIntentId === "string" &&
    typeof o.businessId === "string" &&
    typeof o.idempotencyKey === "string"
  );
}

async function handlePost(req: NextRequest): Promise<NextResponse> {
  const authHeader = req.headers.get("authorization");
  const secret = req.headers.get(TASK_SECRET_HEADER) ?? "";
  const queueHeader = req.headers.get(CLOUD_TASKS_QUEUE_HEADER) ?? "";

  const oidcValid = await verifyOidcToken(authHeader);
  const secretValid = timingSafeEqualStr(secret, EXPECTED_SECRET);

  if (!oidcValid && !secretValid) {
    cloudLog({
      severity: "WARNING",
      component: "System",
      action: "TASK_CANCEL_AUTH_FAILED",
      a2a_transfer: false,
      message: "cancel-payment task auth failed — neither OIDC nor shared secret matched",
    });
    return NextResponse.json({ ok: false, error: "auth_failed" }, { status: 403 });
  }

  if (secretValid && !oidcValid) {
    cloudLog({
      severity: "WARNING",
      component: "System",
      action: "TASK_CANCEL_AUTH_SHARED_SECRET_FALLBACK",
      a2a_transfer: false,
      message: "cancel-payment task authenticated via shared secret only — migrate to OIDC",
    });
  }

  if (!queueHeader) {
    cloudLog({
      severity: "WARNING",
      component: "System",
      action: "TASK_CANCEL_NO_QUEUE_HEADER",
      a2a_transfer: false,
      message: "X-CloudTasks-QueueName header missing — possible non-Cloud-Tasks caller",
    });
    return NextResponse.json({ ok: false, error: "missing_queue_header" }, { status: 400 });
  }

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    cloudLog({
      severity: "ERROR",
      component: "System",
      action: "TASK_CANCEL_BAD_BODY",
      a2a_transfer: false,
      message: "cancel-payment task body is not valid JSON",
    });
    return NextResponse.json({ ok: false, error: "bad_body" });
  }

  if (!isTaskPayload(payload)) {
    cloudLog({
      severity: "ERROR",
      component: "System",
      action: "TASK_CANCEL_INVALID_PAYLOAD",
      a2a_transfer: false,
      message: "cancel-payment task payload missing required fields",
      data: { payload },
    });
    return NextResponse.json({ ok: false, error: "invalid_payload" });
  }

  const { paymentIntentId, businessId, idempotencyKey } = payload;

  const result = await cancelPaymentIntentUseCase({
    businessId,
    actorUserId: SYSTEM_ACTOR_MP_WEBHOOK,
    actorEmployeeId: null,
    paymentIntentId,
    idempotencyKey,
  });

  if (result.outcome === "not_found") {
    cloudLog({
      severity: "WARNING",
      component: "System",
      action: "TASK_CANCEL_NOT_FOUND",
      a2a_transfer: false,
      message: "cancel-payment task: paymentIntent not found — terminal, no retry",
      businessId,
      data: { paymentIntentId },
    });
    return NextResponse.json({ ok: true, outcome: "not_found" });
  }

  if (result.outcome === "not_cancellable") {
    cloudLog({
      severity: "INFO",
      component: "System",
      action: "TASK_CANCEL_NOT_CANCELLABLE",
      a2a_transfer: false,
      message: `cancel-payment task: intent in non-cancellable estado=${result.estado} — terminal`,
      businessId,
      data: { paymentIntentId, estado: result.estado },
    });
    return NextResponse.json({ ok: true, outcome: "not_cancellable" });
  }

  cloudLog({
    severity: "INFO",
    component: "System",
    action: "TASK_CANCEL_PROCESSED",
    a2a_transfer: false,
    message: `cancel-payment task processed outcome=${result.outcome}`,
    businessId,
    data: { paymentIntentId, outcome: result.outcome },
  });

  return NextResponse.json({ ok: true, outcome: result.outcome });
}

export function POST(req: NextRequest): Promise<NextResponse> {
  return runWithTraceContext(req.headers, () => handlePost(req));
}
