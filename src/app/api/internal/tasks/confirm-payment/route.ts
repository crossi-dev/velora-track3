// POST /api/internal/tasks/confirm-payment — Cloud Tasks worker.
//
// Receives the task payload enqueued by the MP webhook handler and calls
// confirmPaymentIntentUseCase synchronously with retry support. After confirm
// returns "confirmed", runPostConfirmSideEffects is awaited BEFORE returning 200
// so Cloud Tasks keeps the connection open until all side effects (WPP comprobante,
// Andreani shipment, WPP tracking) finish. If any side effect throws, the worker
// returns 500 → Cloud Tasks retries. Idempotency atomic-claim stamps
// (comprobanteSentAt / shipmentCreatedAt / trackingWppSentAt) prevent double-send.
//
// Auth: OIDC token (canonical, Google 2026) with shared-secret fallback for the
// 1-deploy migration window. OIDC verification + SA-pinning live in _lib/verify-oidc-token.ts.
// OIDC ref: https://cloud.google.com/tasks/docs/creating-http-target-tasks#token
//
// Retry behaviour: return 500 for transient errors → Cloud Tasks retries with
// configured backoff (10s min, 300s max, 5 attempts). Return 200 for known
// terminal states (already confirmed, not found) so Cloud Tasks does not retry.
// Ref: https://cloud.google.com/tasks/docs/reference/rest/v2/projects.locations.queues#RetryConfig
//
// Idempotency: confirmPaymentIntentUseCase uses beginIdempotentMutation with
// key "mp-confirm-{paymentIntentId}" — safe to run multiple times.

import { NextRequest, NextResponse } from "next/server";
import { cloudLog, runWithTraceContext } from "@/lib/cloud-logger";
import { prisma } from "@/lib/prisma";
import { confirmPaymentIntentUseCase } from "@/app/api/payment-intents/_lib/payment-intent-use-case";
import { runPostConfirmSideEffects } from "@/app/api/payment-intents/_lib/payment-intent-post-confirm";
import { pushOnConfirm } from "@/app/api/integrations/mp/_lib/webhook-push";
import { SYSTEM_ACTOR_MP_WEBHOOK } from "@/lib/system-actors";
import { verifyOidcToken } from "./_lib/verify-oidc-token";
import { timingSafeEqualStr } from "@/app/api/internal/_lib/oidc-verifiers";

// X-CloudTasks-QueueName is injected by Cloud Tasks on every delivery.
// Its presence is a low-cost sanity check that the caller came through Cloud Tasks.
// Ref: https://cloud.google.com/tasks/docs/creating-http-target-tasks#handler
const CLOUD_TASKS_QUEUE_HEADER = "x-cloudtasks-queuename";
const TASK_SECRET_HEADER = "x-velora-task-secret";
const EXPECTED_SECRET = process.env.CRON_SECRET ?? "";

interface TaskPayload {
  paymentIntentId: string;
  businessId: string;
}

function isTaskPayload(v: unknown): v is TaskPayload {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o.paymentIntentId === "string" && typeof o.businessId === "string";
}

async function handlePost(req: NextRequest): Promise<NextResponse> {
  const authHeader = req.headers.get("authorization");
  const secret = req.headers.get(TASK_SECRET_HEADER) ?? "";
  const queueHeader = req.headers.get(CLOUD_TASKS_QUEUE_HEADER) ?? "";

  // Auth: prefer OIDC (canonical Google 2026 pattern). Fall back to shared
  // secret during the 1-deploy migration window.
  // OIDC ref: https://cloud.google.com/tasks/docs/creating-http-target-tasks#token
  const oidcValid = await verifyOidcToken(authHeader);
  const secretValid = timingSafeEqualStr(secret, EXPECTED_SECRET);

  if (!oidcValid && !secretValid) {
    cloudLog({
      severity: "CRITICAL",
      component: "System",
      action: "TASK_CONFIRM_AUTH_FAILED",
      a2a_transfer: false,
      message: "confirm-payment task auth failed — neither OIDC token nor X-Velora-Task-Secret matched",
    });
    // Return 403 (not 200). Cloud Tasks routes 4xx to DLQ for ops inspection.
    // Ref: https://cloud.google.com/tasks/docs/reference/rest/v2/projects.locations.queues#RetryConfig
    return NextResponse.json({ ok: false, error: "auth_failed" }, { status: 403 });
  }

  if (secretValid && !oidcValid) {
    cloudLog({
      severity: "WARNING",
      component: "System",
      action: "TASK_CONFIRM_AUTH_SHARED_SECRET_FALLBACK",
      a2a_transfer: false,
      message: "confirm-payment task authenticated via shared secret only — migrate queue to OIDC: gcloud tasks queues update velora-payment-confirm --oidc-service-account-email=<SA>",
    });
  }

  if (!queueHeader) {
    cloudLog({
      severity: "WARNING",
      component: "System",
      action: "TASK_CONFIRM_NO_QUEUE_HEADER",
      a2a_transfer: false,
      message: "X-CloudTasks-QueueName header missing — possible non-Cloud-Tasks caller",
    });
    // Return 400 so Cloud Tasks routes this to DLQ for ops inspection.
    // Ref: https://cloud.google.com/tasks/docs/reference/rest/v2/projects.locations.queues#RetryConfig
    return NextResponse.json({ ok: false, error: "missing_queue_header" }, { status: 400 });
  }

  // Observability: log trace-context presence so ops can spot uncorrelated requests.
  cloudLog({
    severity: "DEBUG",
    component: "System",
    action: "TASK_CONFIRM_HANDLER_ENTRY",
    a2a_transfer: false,
    message: "confirm-payment handler entry",
    data: {
      traceHeader: req.headers.get("x-cloud-trace-context") ?? "missing",
      queueName: queueHeader,
    },
  });

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    cloudLog({
      severity: "ERROR",
      component: "System",
      action: "TASK_CONFIRM_BAD_BODY",
      a2a_transfer: false,
      message: "confirm-payment task body is not valid JSON",
    });
    // Return 200 — malformed body won't be fixed by retrying.
    return NextResponse.json({ ok: false, error: "bad_body" });
  }

  if (!isTaskPayload(payload)) {
    cloudLog({
      severity: "ERROR",
      component: "System",
      action: "TASK_CONFIRM_INVALID_PAYLOAD",
      a2a_transfer: false,
      message: "confirm-payment task payload missing required fields",
      data: { payload },
    });
    return NextResponse.json({ ok: false, error: "invalid_payload" });
  }

  const { paymentIntentId, businessId } = payload;

  // Idempotent read-first check: if the intent is no longer pending, skip.
  const intent = await prisma.paymentIntent.findFirst({
    where: { id: paymentIntentId, businessId },
    select: { id: true, estado: true, monto: true, createdByEmployeeId: true, matchedCustomerId: true },
  });

  if (!intent) {
    cloudLog({
      severity: "WARNING",
      component: "System",
      action: "TASK_CONFIRM_NOT_FOUND",
      a2a_transfer: false,
      message: `confirm-payment task: paymentIntent not found`,
      businessId,
      data: { paymentIntentId },
    });
    return NextResponse.json({ ok: true, outcome: "not_found" });
  }

  // Bail only on TRULY terminal states. Reconcile runner enqueues
  // `estado IN (pending, expired)` (mp-payment-reconcile-runner.ts:65), and
  // confirmPaymentIntentUseCase has an `isWebhookConfirm=true` reopen branch
  // for expired PIs (confirm-transaction.ts:103-106, 168). Pre-flighting on
  // `!== "pending"` killed every reconcile-enqueued expired PI at the door
  // before the reopen branch could run (audit 2026-05-26 → fix 2026-05-27).
  if (intent.estado === "confirmed" || intent.estado === "cancelled") {
    cloudLog({
      severity: "INFO",
      component: "System",
      action: "TASK_CONFIRM_ALREADY_SETTLED",
      a2a_transfer: false,
      message: `confirm-payment task: intent already in estado=${intent.estado}, skipping`,
      businessId,
      data: { paymentIntentId, estado: intent.estado },
    });
    return NextResponse.json({ ok: true, outcome: "already_settled" });
  }

  // Resolve customer name for push notification — best effort, null falls back
  // to "Cliente" in pushOnConfirm.
  // findFirst with businessId: defense-in-depth tenant guard on customer PII.
  let customerName: string | null = null;
  if (intent.matchedCustomerId) {
    const customer = await prisma.customer.findFirst({
      where: { id: intent.matchedCustomerId, businessId },
      select: { name: true },
    });
    customerName = customer?.name ?? null;
  }

  // Synchronous confirm — Cloud Tasks waits for this response.
  let result: Awaited<ReturnType<typeof confirmPaymentIntentUseCase>>;
  try {
    result = await confirmPaymentIntentUseCase({
      businessId,
      actorUserId: SYSTEM_ACTOR_MP_WEBHOOK,
      actorEmployeeId: null,
      paymentIntentId,
      idempotencyKey: `mp-confirm-${paymentIntentId}`,
    });
  } catch (useErr) {
    const msg = useErr instanceof Error ? useErr.message : String(useErr);
    cloudLog({
      severity: "ERROR",
      component: "System",
      action: "TASK_CONFIRM_USE_CASE_ERROR",
      a2a_transfer: false,
      message: `confirmPaymentIntentUseCase threw: ${msg}`,
      businessId,
      data: { paymentIntentId, error: msg },
    });
    throw useErr; // Re-throw so Cloud Tasks retries (500 path).
  }

  if (result.outcome === "confirmed") {
    // Fire-and-forget: push notification is best-effort.
    void pushOnConfirm({
      businessId,
      paymentIntentId,
      monto: Number(intent.monto),
      createdByEmployeeId: intent.createdByEmployeeId,
      customerName,
    });

    // Await durable side effects synchronously. If any throw, Cloud Tasks retries.
    // Idempotency stamps prevent double-send across retries.
    // Ref: https://cloud.google.com/tasks/docs/creating-http-target-tasks#handler
    await runPostConfirmSideEffects(paymentIntentId, businessId);
  }

  cloudLog({
    severity: "INFO",
    component: "System",
    action: "TASK_CONFIRM_PROCESSED",
    a2a_transfer: false,
    message: `confirm-payment task processed outcome=${result.outcome}`,
    businessId,
    data: { paymentIntentId, outcome: result.outcome },
  });

  return NextResponse.json({ ok: true, outcome: result.outcome });
}

export function POST(req: NextRequest): Promise<NextResponse> {
  return runWithTraceContext(req.headers, () => handlePost(req));
}
