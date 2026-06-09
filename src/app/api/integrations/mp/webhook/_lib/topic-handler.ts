// Per-topic MP webhook processing.
//
// Given the resolved accessToken and topic, this module:
//   1. GETs the MP resource (payment or merchant_order) with backoff + timeout.
//   2. Checks the status gate per topic (payment=approved, order_status=paid).
//   3. Parses external_reference ("{businessId}:{paymentIntentId}") and validates
//      it against the ?businessId= query param used for token resolution.
//   4. DB tenant-guard: verifies paymentIntent belongs to the declared businessId.
//   5. Enqueues a Cloud Tasks task to confirm the payment intent durably.
//
// Cloud Tasks pattern: validate → enqueue → return 200 immediately.
// The worker at /api/internal/tasks/confirm-payment processes synchronously
// with up to 5 retries (10s–300s backoff) and a DLQ for permanent failures.
// Ref: https://cloud.google.com/tasks/docs/creating-http-target-tasks
// Stripe canonical: https://stripe.com/docs/webhooks/best-practices#acknowledge-events-immediately
//
// Returns a NextResponse the caller returns to MP.

import { NextResponse } from "next/server";
import { cloudLog } from "@/lib/cloud-logger";
import { prisma } from "@/lib/prisma";
import { enqueuePaymentConfirm, enqueuePaymentCancel } from "@/lib/cloud-tasks-enqueue";
import {
  CONFIRMABLE_STATUSES,
  REJECTED_STATUSES,
  REFUND_DISPUTE_STATUSES,
} from "@/app/api/integrations/mp/_lib/mp-status-mapping";
import { recordMismatch } from "../../_lib/webhook-security";
import { mpFetchWithBackoff } from "../../_lib/mp-fetch";
import { logNonConfirmableStatus, handleRefundDisputeCancel } from "./mp-status-logger";

const MP_API_BASE = "https://api.mercadopago.com";
// Outer AbortController timeout — must exceed mpFetchWithBackoff's per-attempt
// timeout so the first attempt completes before the signal fires.
// mpFetchWithBackoff internal per-attempt timeout = 10 s. We add 2 s headroom
// so abort only fires if the internal retry itself hangs (not on first attempt).
// Previous value was 8 s which fired BEFORE the 10 s first attempt completed
// during MP incidents → premature abort → MP retry storm.
// Ref: https://stripe.com/docs/webhooks/best-practices#acknowledge-events-immediately
const WEBHOOK_VERIFY_TIMEOUT_MS = 12_000;

export async function handleWebhookTopic({
  topic,
  mpOrderId,
  accessToken,
  businessIdFromQuery,
  clientIp,
}: {
  topic: string;
  mpOrderId: string;
  accessToken: string;
  businessIdFromQuery: string | null;
  clientIp: string;
}): Promise<NextResponse> {
  const apiPath =
    topic === "payment"
      ? `/v1/payments/${encodeURIComponent(mpOrderId)}`
      : `/merchant_orders/${encodeURIComponent(mpOrderId)}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WEBHOOK_VERIFY_TIMEOUT_MS);
  let resourceRes: Response;
  try {
    resourceRes = await mpFetchWithBackoff(`${MP_API_BASE}${apiPath}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!resourceRes.ok) {
    cloudLog({
      severity: "WARNING",
      component: "System",
      action: "MP_WEBHOOK_RESOURCE_FETCH_FAILED",
      a2a_transfer: false,
      message: `MP ${topic} fetch falló status=${resourceRes.status}`,
      data: { mpOrderId, topic, status: resourceRes.status },
    });
    // 5xx → propagate 502 so Cloud Tasks / MP retries.
    if (resourceRes.status >= 500) {
      return NextResponse.json(
        { type: "urn:velora:mp-upstream-error", title: "MP upstream error", status: 502 },
        { status: 502 },
      );
    }
    // 429 (rate-limit) or 503 → return the same status to MP so it backs off and
    // retries. Other 4xx (e.g. 404 = stale notification) return 200 (ignored).
    if (resourceRes.status === 429 || resourceRes.status === 503) {
      return NextResponse.json(
        { type: "urn:velora:mp-upstream-rate-limit", title: "MP upstream rate-limited", status: resourceRes.status },
        { status: resourceRes.status },
      );
    }
    return NextResponse.json({ ok: true, ignored: `fetch_${resourceRes.status}` });
  }

  const resource = await resourceRes.json();

  let externalRef: string;
  if (topic === "payment") {
    const paymentStatus = String(resource?.status ?? "");

    // J#1: gate on CONFIRMABLE_STATUSES (approved + authorized) — authorized covers
    // deferred-capture/installment; reconcile cron maps it correctly via mapMpStatusToVeloraStatus.
    if (!CONFIRMABLE_STATUSES.has(paymentStatus)) {
      const ref = String(resource?.external_reference ?? "");
      const colonIdx = ref.indexOf(":");
      const refBusinessId = colonIdx > 0 ? ref.slice(0, colonIdx) : "";
      const refPaymentIntentId = colonIdx > 0 ? ref.slice(colonIdx + 1) : "";

      // N#6: structured log for every non-CONFIRMABLE status.
      logNonConfirmableStatus({ paymentStatus, refBusinessId, refPaymentIntentId, mpPaymentId: mpOrderId });

      // J#2: rejected/cancelled → enqueue cancel task with idempotency key shared
      // with reconcile cron so a race cancels exactly once (DB unique constraint).
      if (REJECTED_STATUSES.has(paymentStatus) && refBusinessId && refPaymentIntentId) {
        await enqueuePaymentCancel({
          paymentIntentId: refPaymentIntentId,
          businessId: refBusinessId,
          idempotencyKey: `mp-reject-${refPaymentIntentId}`,
        }).then(() => {
          cloudLog({
            severity: "WARNING",
            component: "System",
            action: "MP_WEBHOOK_STATUS_REJECTED",
            a2a_transfer: false,
            message: `MP webhook: terminal status=${paymentStatus} → cancel task enqueued`,
            businessId: refBusinessId,
            data: { paymentStatus, paymentIntentId: refPaymentIntentId, mpPaymentId: mpOrderId },
          });
        }).catch((err) => {
          cloudLog({
            severity: "ERROR",
            component: "System",
            action: "MP_WEBHOOK_REJECT_CANCEL_ENQUEUE_ERROR",
            a2a_transfer: false,
            message: `enqueuePaymentCancel failed for rejected webhook: ${err instanceof Error ? err.message : String(err)}`,
            data: { paymentStatus, ref },
          });
          // Mirror the confirm enqueue failure path: stamp reconcileFastTrack so
          // the reconcile cron picks up this PI on the very next tick.
          // Without this the PI stays pending until the normal staleness window.
          // Ref: https://stripe.com/docs/webhooks/process-undelivered-events
          prisma.paymentIntent.updateMany({
            where: { id: refPaymentIntentId, businessId: refBusinessId },
            data: { reconcileFastTrack: true },
          }).catch(() => {
            // Best-effort — if this DB write fails the reconcile cron's normal
            // staleness window is still the safety net. Do not throw.
          });
        });
      }

      // JD Fix #2: REFUND_DISPUTE_STATUSES enqueue cancel task + reconcileFastTrack.
      // Extracted to handleRefundDisputeCancel (mp-status-logger.ts) for size contract.
      if (REFUND_DISPUTE_STATUSES.has(paymentStatus)) {
        await handleRefundDisputeCancel({ paymentStatus, refBusinessId, refPaymentIntentId, mpPaymentId: mpOrderId });
      }

      return NextResponse.json({ ok: true, ignored: `paymentStatus=${paymentStatus}` });
    }
    externalRef = String(resource?.external_reference ?? "");
  } else {
    // merchant_order: MP garantiza order_status="paid" sólo cuando hay al
    // menos un pago aprobado. Nunca confirmar sólo por status.
    const orderStatus = String(resource?.order_status ?? "");
    const status = String(resource?.status ?? "");
    if (orderStatus !== "paid") {
      return NextResponse.json({ ok: true, ignored: `orderStatus=${orderStatus}/status=${status}` });
    }
    externalRef = String(resource?.external_reference ?? "");

    // M3 FIX: defense-in-depth — for merchant_order, validate external_reference
    // starts with "{businessIdFromQuery}:" BEFORE we parse it, matching the
    // per-payment-topic guard already in topic-token-resolver. This prevents a
    // crafted merchant_order (attacker with own POS) from confirming a payment
    // intent belonging to a different tenant via the QR path.
    // SEC-N-11: recordMismatch so cross-tenant tampering accumulates IP ban score.
    if (businessIdFromQuery && !externalRef.startsWith(`${businessIdFromQuery}:`)) {
      recordMismatch(clientIp);
      cloudLog({
        severity: "WARNING",
        component: "System",
        action: "MP_WEBHOOK_MERCHANT_ORDER_REF_MISMATCH",
        a2a_transfer: false,
        message: "merchant_order external_reference does not start with expected businessId prefix",
        data: { businessIdFromQuery, externalRef: externalRef.slice(0, 80), mpOrderId },
      });
      return NextResponse.json({ ok: true, ignored: "merchant_order_ref_mismatch" });
    }
  }

  // external_reference = "{businessId}:{paymentIntentId}". Verificamos en
  // DB que el paymentIntent pertenezca al businessId — sin esto, un attacker
  // con POS propio podría craftear external_reference apuntando al intent
  // de otro tenant y forzar confirmación cruzada.
  const colonIdx = externalRef.indexOf(":");
  const businessId = colonIdx > 0 ? externalRef.slice(0, colonIdx) : "";
  const paymentIntentId = colonIdx > 0 ? externalRef.slice(colonIdx + 1) : "";
  if (!businessId || !paymentIntentId) {
    cloudLog({
      severity: "ERROR",
      component: "System",
      action: "MP_WEBHOOK_BAD_REF",
      a2a_transfer: false,
      message: "external_reference no parseable",
      data: { externalRef, mpOrderId },
    });
    return NextResponse.json({ ok: true, ignored: "bad_external_ref" });
  }

  // Belt-and-suspenders: verify that the businessId used for token resolution
  // (from ?businessId= query param) matches the one in external_reference
  // (from MP's authoritative response body).
  // SEC-N-11: recordMismatch so query-param businessId spoofing accumulates IP ban score.
  if (businessIdFromQuery && businessIdFromQuery !== businessId) {
    recordMismatch(clientIp);
    cloudLog({
      severity: "WARNING",
      component: "System",
      action: "MP_WEBHOOK_BUSINESSID_MISMATCH",
      a2a_transfer: false,
      message: "?businessId query param no coincide con external_reference",
      data: { businessIdFromQuery, businessId, mpOrderId },
    });
    return NextResponse.json({ ok: true, ignored: "businessid_mismatch" });
  }

  // Tenant-guard: verify the paymentIntent belongs to the businessId in external_reference.
  // Without this, a crafted external_reference could trigger a confirm for another tenant.
  // We only need the id — all other fields are resolved by the worker.
  const intent = await prisma.paymentIntent.findFirst({
    where: { id: paymentIntentId, businessId },
    select: { id: true },
  });
  if (!intent) {
    recordMismatch(clientIp);
    cloudLog({
      severity: "WARNING",
      component: "System",
      action: "MP_WEBHOOK_TENANT_MISMATCH",
      a2a_transfer: false,
      message:
        "paymentIntent no pertenece al businessId declarado en external_reference — possible cross-tenant attack",
      data: { externalRef, mpOrderId, businessId, paymentIntentId, clientIp },
    });
    return NextResponse.json({ ok: true, ignored: "tenant_mismatch" });
  }

  // Cloud Tasks enqueue — synchronous before returning 200 so the task is
  // durably queued before MP receives the acknowledgement.
  // The worker at /api/internal/tasks/confirm-payment runs confirmPaymentIntentUseCase
  // synchronously with up to 5 retries; Cloud Run will NOT kill it mid-transaction.
  //
  // DI-CRIT-1 preserved: the worker uses key `mp-confirm-{paymentIntentId}` — same
  // slot as the reconcile cron — so only one caller wins the idempotency race.
  //
  // On enqueue failure: log ERROR and still return 200 so MP does not retry.
  // The reconcile cron (*/15 * * * *) is the safety net for missed confirms.
  // Ref: https://cloud.google.com/tasks/docs/creating-http-target-tasks
  try {
    await enqueuePaymentConfirm({ paymentIntentId, businessId });
    cloudLog({
      severity: "INFO",
      component: "System",
      action: "MP_WEBHOOK_TASK_ENQUEUED",
      a2a_transfer: false,
      message: `MP webhook: Cloud Task enqueued for confirm topic=${topic}`,
      businessId,
      data: { mpOrderId, topic, paymentIntentId },
    });
  } catch (enqueueErr) {
    cloudLog({
      severity: "ERROR",
      component: "System",
      action: "MP_WEBHOOK_ENQUEUE_FAILED",
      a2a_transfer: false,
      message: `Cloud Tasks enqueue failed — reconcile cron is safety net: ${enqueueErr instanceof Error ? enqueueErr.message : String(enqueueErr)}`,
      businessId,
      data: { mpOrderId, topic, paymentIntentId },
    });
    // Mark fast-track so the reconcile cron (*/5 * * * *) picks up this PI on
    // the very next tick without waiting for the 5-min staleness window.
    // Ref: https://stripe.com/docs/webhooks/process-undelivered-events
    await prisma.paymentIntent.updateMany({
      where: { id: paymentIntentId, businessId },
      data: { reconcileFastTrack: true },
    }).catch(() => {
      // Best-effort — if the DB write fails here the reconcile cron's normal
      // staleness window (5 min) is still the safety net. Do not throw.
    });
  }

  return NextResponse.json({ ok: true, accepted: true });
}
