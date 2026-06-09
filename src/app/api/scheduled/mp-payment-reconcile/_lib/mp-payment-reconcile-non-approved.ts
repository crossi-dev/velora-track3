// Non-approved status handler for the MP reconcile cron.
// Extracted from mp-payment-reconcile-runner.ts to keep that file under the
// 300-line hard limit. Handles every MP status that is NOT "approved" —
// rejected (triggers cancel), refunded/disputed (logged for owner review),
// pending (left as-is for next tick).
//
// Stripe canonical: terminal rejection MUST flip merchant-side state
// immediately so the UI reflects truth instead of waiting for audit-cleanup.
// Reference: docs.stripe.com/webhooks/process-undelivered-events

import { cloudLog } from "@/lib/cloud-logger";
import { cancelPaymentIntentUseCase } from "@/app/api/payment-intents/_lib/cancel-payment-intent-use-case";

export type NonApprovedOutcome = "rejected" | "refunded" | "disputed" | "pending" | "other";

export interface NonApprovedInput {
  paymentIntentId: string;
  businessId: string;
  providerRef: string;
  mpStatus: string;
}

/**
 * Logs the MP status outcome and, for `rejected`, cancels the PI so the owner
 * sees accurate state without waiting for audit-cleanup. Idempotency key
 * `mp-reject-{id}` is shared with the webhook handler — webhook+reconcile race
 * cancels exactly once via the IdempotencyRecord unique constraint.
 */
export async function handleNonApprovedStatus(input: NonApprovedInput): Promise<void> {
  const { paymentIntentId, businessId, providerRef, mpStatus } = input;

  let action = "MP_RECONCILE_NOT_APPROVED";
  let severity: "INFO" | "WARNING" | "ERROR" = "INFO";
  if (mpStatus === "rejected") {
    action = "MP_RECONCILE_REJECTED";
    severity = "WARNING";
  } else if (mpStatus === "refunded" || mpStatus === "disputed") {
    action = "MP_RECONCILE_REFUND_OR_DISPUTE";
    severity = "ERROR";
  } else if (mpStatus === "pending") {
    action = "MP_RECONCILE_REVIEWING";
  }

  cloudLog({
    severity,
    component: "System",
    action,
    a2a_transfer: false,
    message: `reconcile: MP status=${mpStatus} — leaving as-is (next reconcile will retry unless terminal)`,
    data: { paymentIntentId, preferenceId: providerRef, mpStatus },
    businessId,
  });

  if (mpStatus !== "rejected") return;

  try {
    const cancelResult = await cancelPaymentIntentUseCase({
      businessId,
      actorUserId: "system-mp-reconcile",
      actorEmployeeId: null,
      paymentIntentId,
      idempotencyKey: `mp-reject-${paymentIntentId}`,
    });
    cloudLog({
      severity: "INFO",
      component: "System",
      action: "MP_RECONCILE_REJECTED_CANCELLED",
      a2a_transfer: false,
      message: `reconcile: rejected PI cancel outcome=${cancelResult.outcome}`,
      data: { paymentIntentId, outcome: cancelResult.outcome },
      businessId,
    });
  } catch (cancelErr) {
    cloudLog({
      severity: "ERROR",
      component: "System",
      action: "MP_RECONCILE_REJECT_CANCEL_ERROR",
      a2a_transfer: false,
      message: `reconcile: cancelPaymentIntentUseCase threw: ${cancelErr instanceof Error ? cancelErr.message : String(cancelErr)}`,
      data: { paymentIntentId },
      businessId,
    });
  }
}
