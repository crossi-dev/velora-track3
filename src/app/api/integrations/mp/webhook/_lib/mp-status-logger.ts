// mp-status-logger.ts — N#6 observability: structured cloudLog for every
// non-CONFIRMABLE MP payment status received via webhook.
//
// Also exports handleRefundDisputeCancel — the action half for chargeback /
// refunded / partially_refunded statuses (JD Fix #2). Extracted here to keep
// topic-handler.ts under the 300-line server/api size contract.

import { cloudLog } from "@/lib/cloud-logger";
import { prisma } from "@/lib/prisma";
import { enqueuePaymentCancel } from "@/lib/cloud-tasks-enqueue";
import {
  REVIEWING_STATUSES,
  REJECTED_STATUSES,
  REFUND_DISPUTE_STATUSES,
} from "@/app/api/integrations/mp/_lib/mp-status-mapping";

/**
 * Emits a structured cloudLog entry for a non-CONFIRMABLE MP payment status.
 * Called BEFORE any cancel/return logic so Cloud Logging captures every event.
 *
 * Action name → severity map:
 *   in_process / pending / in_mediation  → MP_WEBHOOK_STATUS_REVIEWING   (INFO)
 *   rejected / cancelled                 → MP_WEBHOOK_STATUS_REJECTED    (WARNING, via cancel then())
 *   refunded / partially_refunded        → MP_WEBHOOK_STATUS_REFUNDED    (ERROR)
 *   charged_back                         → MP_WEBHOOK_STATUS_CHARGEBACK  (ERROR)
 *   (unknown)                            → MP_WEBHOOK_STATUS_UNKNOWN     (INFO)
 */
export function logNonConfirmableStatus({
  paymentStatus,
  refBusinessId,
  refPaymentIntentId,
  mpPaymentId,
}: {
  paymentStatus: string;
  refBusinessId: string;
  refPaymentIntentId: string;
  mpPaymentId: string;
}): void {
  const biz = refBusinessId || undefined;
  const data = { paymentStatus, paymentIntentId: refPaymentIntentId, mpPaymentId };

  if (REVIEWING_STATUSES.has(paymentStatus)) {
    cloudLog({
      severity: "INFO",
      component: "System",
      action: "MP_WEBHOOK_STATUS_REVIEWING",
      a2a_transfer: false,
      message: `MP webhook: payment still under review, status=${paymentStatus}`,
      businessId: biz,
      data,
    });
  } else if (REFUND_DISPUTE_STATUSES.has(paymentStatus)) {
    const isChargeback = paymentStatus === "charged_back";
    cloudLog({
      severity: "ERROR",
      component: "System",
      action: isChargeback ? "MP_WEBHOOK_STATUS_CHARGEBACK" : "MP_WEBHOOK_STATUS_REFUNDED",
      a2a_transfer: false,
      message: `MP webhook: post-payment reversal, status=${paymentStatus}`,
      businessId: biz,
      data,
    });
  } else if (REJECTED_STATUSES.has(paymentStatus)) {
    // Unconditional REJECTED log BEFORE cancel enqueue — double-failure audit trail.
    // Previously this log was emitted only inside cancelPaymentIntentUseCase.then()
    // meaning if the cancel enqueue itself failed (e.g. Cloud Tasks outage), there
    // was NO audit trail for the rejection at all.
    // Ref: B7 fix #8 — log before enqueue, not inside .then().
    cloudLog({
      severity: "WARNING",
      component: "System",
      action: "MP_WEBHOOK_STATUS_REJECTED",
      a2a_transfer: false,
      message: `MP webhook: payment rejected/cancelled, status=${paymentStatus} — cancel will be enqueued`,
      businessId: biz,
      data,
    });
  } else {
    // Unknown — not reviewing, not rejected, not refund/dispute, not confirmable.
    cloudLog({
      severity: "INFO",
      component: "System",
      action: "MP_WEBHOOK_STATUS_UNKNOWN",
      a2a_transfer: false,
      message: `MP webhook: unrecognised payment status=${paymentStatus}`,
      businessId: biz,
      data,
    });
  }
}

/**
 * JD Fix #2 — action half for REFUND_DISPUTE_STATUSES.
 *
 * Enqueues a cancel task and stamps reconcileFastTrack so the PI is not left
 * "confirmed" in Velora DB while MP has reversed the payment.
 *
 * NOTE: cancelPaymentIntentUseCase currently transitions to "cancelled".
 * TODO(follow-up): add targetEstado param so "refunded"/"partially_refunded"
 * MP statuses map to a distinct Velora estado instead of "cancelled".
 *
 * Idempotency key "mp-chargeback-{id}" is distinct from the reject key
 * ("mp-reject-{id}") so concurrent status webhooks don't collide.
 */
export async function handleRefundDisputeCancel({
  paymentStatus,
  refBusinessId,
  refPaymentIntentId,
  mpPaymentId,
}: {
  paymentStatus: string;
  refBusinessId: string;
  refPaymentIntentId: string;
  mpPaymentId: string;
}): Promise<void> {
  if (!REFUND_DISPUTE_STATUSES.has(paymentStatus)) return;
  if (!refBusinessId || !refPaymentIntentId) return;

  cloudLog({
    severity: "CRITICAL",
    component: "System",
    action: "MP_WEBHOOK_STATUS_CHARGEBACK_OR_REFUND",
    a2a_transfer: false,
    message: `MP webhook: post-payment reversal status=${paymentStatus} — cancel task enqueued, reconcileFastTrack set`,
    businessId: refBusinessId,
    data: { paymentStatus, paymentIntentId: refPaymentIntentId, mpPaymentId },
  });
  await enqueuePaymentCancel({
    paymentIntentId: refPaymentIntentId,
    businessId: refBusinessId,
    idempotencyKey: `mp-chargeback-${refPaymentIntentId}`,
  }).catch((err) => {
    cloudLog({
      severity: "ERROR",
      component: "System",
      action: "MP_WEBHOOK_CHARGEBACK_CANCEL_ENQUEUE_ERROR",
      a2a_transfer: false,
      message: `enqueuePaymentCancel failed for chargeback/refund: ${err instanceof Error ? err.message : String(err)}`,
      data: { paymentStatus, paymentIntentId: refPaymentIntentId, mpPaymentId },
    });
  });
  // Always stamp reconcileFastTrack — belt-and-suspenders guard for Cloud Tasks outage.
  await prisma.paymentIntent.updateMany({
    where: { id: refPaymentIntentId, businessId: refBusinessId },
    data: { reconcileFastTrack: true },
  }).catch(() => {
    // Best-effort — reconcile cron's normal staleness window is the fallback.
  });
}
