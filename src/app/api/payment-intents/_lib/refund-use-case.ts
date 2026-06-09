// Refund use-case del PaymentIntent — slice 5 ("devolución cash V1").
//
// Vive en sibling separado para preservar el hard limit de 300 LOC en
// `payment-intent-use-case.ts` (que ya estaba cerca del techo tras el slice 3).
//
// Patrón canónico: idempotency begin → transaction → complete + audit, o
// release en error. Mirror exacto del confirm flow, con la diferencia de
// que el rechazo "not_confirmed" es un 400 (estado inválido para refund),
// no un 409.

import { prisma } from "@/lib/prisma";
import { recordCriticalWriteEvent } from "@/infrastructure/shared/critical-write-audit";
import {
  beginIdempotentMutation,
  completeIdempotentMutation,
  releaseIdempotentMutation,
} from "@/app/api/_lib/idempotency";
import { getServerActionMeta } from "@/app/api/_lib/mutation-contract";
import { runRefundTransaction } from "./refund-transaction";
import { sendCustomerRefundNotification } from "@/app/api/agents/communications/jsonrpc/_lib/handle-communications-rpc";
import { publishPostCommitFailure } from "@/app/api/_lib/post-commit-failure-publisher";
import { cloudLog } from "@/lib/cloud-logger";

const REFUND_ACTION = getServerActionMeta("payment_intent.refund");

export interface RefundPaymentIntentInput {
  businessId: string;
  actorUserId: string;
  actorEmployeeId: string | null;
  paymentIntentId: string;
  idempotencyKey: string;
}

export type RefundPaymentIntentResult =
  | {
      outcome: "refunded";
      paymentIntentId: string;
      saleId: string | null;
      monto: number;
      refundedAt: string;
    }
  | { outcome: "not_found" }
  | { outcome: "not_confirmed"; estado: string }
  | { outcome: "replayed"; status: number; body: unknown }
  | { outcome: "idempotency_missing" }
  | { outcome: "idempotency_conflict" }
  | { outcome: "idempotency_in_flight" };

export async function refundPaymentIntentUseCase(
  input: RefundPaymentIntentInput,
): Promise<RefundPaymentIntentResult> {
  const idempotency = await beginIdempotentMutation({
    client: prisma,
    businessId: input.businessId,
    actionType: REFUND_ACTION.actionType,
    idempotencyKey: input.idempotencyKey,
    requestBody: { paymentIntentId: input.paymentIntentId },
  });

  if (idempotency.kind === "replay") {
    const body = await idempotency.response.json();
    return { outcome: "replayed", status: idempotency.response.status, body };
  }
  if (idempotency.kind === "missing") return { outcome: "idempotency_missing" };
  if (idempotency.kind === "conflict") return { outcome: "idempotency_conflict" };
  if (idempotency.kind === "in_flight") return { outcome: "idempotency_in_flight" };

  const recordId = idempotency.recordId;

  try {
    const result = await runRefundTransaction(input);

    if (result.outcome !== "refunded") {
      await releaseIdempotentMutation({ client: prisma, recordId });
      return result;
    }

    // Use the timestamp set inside the transaction so the response matches the DB.
    const refundedAt = result.refundedAt.toISOString();
    const responseBody = {
      ok: true,
      paymentIntentId: result.paymentIntentId,
      saleId: result.saleId,
      monto: result.monto,
      refundedAt,
    };

    await completeIdempotentMutation({
      client: prisma,
      recordId,
      responseStatus: 200,
      responseBody,
    });

    await recordCriticalWriteEvent({
      client: prisma,
      businessId: input.businessId,
      actorUserId: input.actorUserId,
      actorEmployeeId: input.actorEmployeeId,
      routeScope: REFUND_ACTION.routeScope,
      actionType: REFUND_ACTION.actionType,
      resourceType: REFUND_ACTION.resourceType,
      resourceId: result.paymentIntentId,
      summary: `Devolución cash $${result.monto} (intent ${result.paymentIntentId})`,
      payload: {
        paymentIntentId: result.paymentIntentId,
        saleId: result.saleId,
        monto: result.monto,
      },
    });

    // Customer WPP notification — best-effort, fire-and-forget after commit.
    // Atomic claim (CAS) on refundNotificationSentAt prevents double-fire on retry.
    void (async () => {
      // Resolve customer phone + business name in a single round-trip.
      const intent = await prisma.paymentIntent.findFirst({
        where: { id: result.paymentIntentId, businessId: input.businessId },
        select: {
          matchedCustomerId: true,
          refundNotificationSentAt: true,
          business: { select: { name: true } },
          sale: { select: { customer: { select: { phone: true, name: true } } } },
        },
      });
      if (!intent) return;

      // Atomic claim — bail if already sent (concurrent runner or cron replay).
      const claimTime = new Date();
      const claimed = await prisma.paymentIntent.updateMany({
        where: { id: result.paymentIntentId, refundNotificationSentAt: null },
        data: { refundNotificationSentAt: claimTime },
      });
      if (claimed.count === 0) return;

      let customerPhone: string | null = null;
      let customerName: string | null = null;

      // Resolution order: matchedCustomerId first, then sale.customer fallback.
      // findFirst with businessId: defense-in-depth tenant guard on customer PII.
      if (intent.matchedCustomerId) {
        const customer = await prisma.customer.findFirst({
          where: { id: intent.matchedCustomerId, businessId: input.businessId },
          select: { phone: true, name: true },
        });
        customerPhone = customer?.phone ?? null;
        customerName = customer?.name ?? null;
      }
      if (!customerPhone) {
        customerPhone = intent.sale?.customer?.phone ?? null;
        if (!customerName) customerName = intent.sale?.customer?.name ?? null;
      }

      if (!customerPhone) return; // skip silently — no phone on record

      try {
        await sendCustomerRefundNotification({
          businessId: input.businessId,
          customerPhone,
          customerName,
          businessName: intent.business?.name ?? "",
          amount: result.monto,
          reason: "refund",
          referenceId: result.paymentIntentId,
        });
      } catch (notifyErr) {
        const notifyMsg = notifyErr instanceof Error ? notifyErr.message : String(notifyErr);
        cloudLog({
          severity: "WARNING",
          component: "System",
          action: "REFUND_NOTIFICATION_WPP_FAILED",
          a2a_transfer: false,
          message: `Refund WPP notification failed — rolling back refundNotificationSentAt claim: ${notifyMsg}`,
          data: { paymentIntentId: result.paymentIntentId },
          businessId: input.businessId,
        });
        // Roll back the claim so the retry cron can re-enter.
        // If rollback fails (DB blip), log CRITICAL + dead-letter via publishPostCommitFailure.
        // Mirrors B9 claimAndSendTrackingWpp pattern.
        try {
          await prisma.paymentIntent.updateMany({
            where: { id: result.paymentIntentId, refundNotificationSentAt: claimTime },
            data: { refundNotificationSentAt: null },
          });
        } catch (rollbackErr) {
          const rollbackMsg = rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
          cloudLog({
            severity: "CRITICAL",
            component: "System",
            action: "REFUND_NOTIFICATION_ROLLBACK_FAILED",
            a2a_transfer: false,
            message: `refundPaymentIntentUseCase: rollback failed — refundNotificationSentAt may be permanently stale: ${rollbackMsg}`,
            data: { paymentIntentId: result.paymentIntentId },
            businessId: input.businessId,
          });
          void publishPostCommitFailure({
            businessId: input.businessId,
            saleId: result.saleId ?? null,
            action: "REFUND_NOTIFICATION_ROLLBACK_FAILED",
            errorMessage: rollbackMsg,
            originalArgs: { paymentIntentId: result.paymentIntentId },
          });
        }
      }
    })();

    return {
      outcome: "refunded",
      paymentIntentId: result.paymentIntentId,
      saleId: result.saleId,
      monto: result.monto,
      refundedAt,
    };
  } catch (error) {
    await releaseIdempotentMutation({ client: prisma, recordId });
    throw error;
  }
}
