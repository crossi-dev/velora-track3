// Use-case: confirm a PaymentIntent as a "promesa de pago" (accounts-receivable
// accrual path). The payment is NOT collected today — the owner records when they
// expect to receive cash (expectedAt) and optionally a reason. Bookkeeping follows
// the standard AR accrual pattern: record the receivable now, collect cash later.
//
// Post-confirm chain: same runPostConfirmSideEffects fired by the QR/link confirm
// path — fiscal receipt + shipment + WhatsApp notice + push if applicable.
//
// No idempotency-header gate here (no gateway webhook, no client retry key).
// Re-entrancy is guarded by the DB state check: a confirmed PI returns
// "already_confirmed" on every subsequent call.

import { prisma } from "@/lib/prisma";
import { cloudLog } from "@/lib/cloud-logger";
import { recordCriticalWriteEvent } from "@/infrastructure/shared/critical-write-audit";
import { getServerActionMeta } from "@/app/api/_lib/mutation-contract";
import { runPostConfirmSideEffects } from "./payment-intent-post-confirm";

const CONFIRM_PROMESA_ACTION = getServerActionMeta("payment_intent.confirm_promesa");

export interface ConfirmPromesaInput {
  paymentIntentId: string;
  businessId: string;
  actorUserId: string;
  /** When the owner expects the cash to arrive (e.g. +30 days from now). */
  expectedAt: Date;
  /** Optional human note — e.g. "Juan me prometió pagar el mes que viene". */
  reason?: string;
}

export type ConfirmPromesaResult =
  | { outcome: "confirmed"; paymentIntentId: string; promesaExpectedAt: Date }
  | { outcome: "already_confirmed"; paymentIntentId: string }
  | { outcome: "not_found" }
  | { outcome: "wrong_state"; currentState: string };

export async function confirmPromesaPaymentUseCase(
  input: ConfirmPromesaInput,
): Promise<ConfirmPromesaResult> {
  const now = new Date();

  const result = await prisma.$transaction(async (tx) => {
    const intent = await tx.paymentIntent.findFirst({
      where: { id: input.paymentIntentId, businessId: input.businessId },
      select: {
        id: true,
        estado: true,
        monto: true,
        saleId: true,
      },
    });

    if (!intent) {
      return { outcome: "not_found" as const };
    }

    if (intent.estado === "confirmed") {
      return { outcome: "already_confirmed" as const, paymentIntentId: intent.id };
    }

    // Only pending and expired intents are eligible for a promesa.
    // "cancelled" or any unknown future state is rejected.
    if (intent.estado !== "pending" && intent.estado !== "expired") {
      return {
        outcome: "wrong_state" as const,
        currentState: intent.estado,
      };
    }

    // Optimistic-concurrency guard (mirrors confirm-transaction.ts): the findFirst
    // above is a stale READ COMMITTED snapshot and takes no row lock, so two
    // concurrent confirms can both pass the estado check. updateMany with the
    // estado guard makes exactly one win; the loser gets count===0 and returns
    // already_confirmed without writing a duplicate CashMovement.
    const piUpdate = await tx.paymentIntent.updateMany({
      where: { id: intent.id, businessId: input.businessId, estado: { in: ["pending", "expired"] } },
      data: {
        estado: "confirmed",
        confirmedAt: now,
        metodo: "promesa",
        promesaExpectedAt: input.expectedAt,
      },
    });
    if (piUpdate.count === 0) {
      return { outcome: "already_confirmed" as const, paymentIntentId: intent.id };
    }

    // Mark the linked sale as paid if one exists and isn't already.
    // Same guard as confirm-transaction.ts — tenant-scoped findFirst before update.
    if (intent.saleId) {
      const sale = await tx.sale.findFirst({
        where: { id: intent.saleId, businessId: input.businessId },
        select: { id: true, status: true },
      });
      if (sale && sale.status !== "paid") {
        await tx.sale.update({
          where: { id: sale.id },
          data: { status: "paid" },
        });
      }
    }

    // Accrual CashMovement: type "in" records the AR receivable. The description
    // surfaces the expected collection date so the cash-register view is readable.
    const expectedDateStr = input.expectedAt.toISOString().slice(0, 10);
    const description =
      `Promesa de pago — vence ${expectedDateStr}` +
      (input.reason ? ` — ${input.reason}` : "");

    // createMany + skipDuplicates → INSERT ... ON CONFLICT DO NOTHING on the
    // partial unique (businessId, clientMessageId). A concurrent/retried confirm
    // is silently skipped instead of throwing P2002 (which previously surfaced as
    // an unhandled 500 even though the PI was confirmed). Mirrors confirm-transaction.ts.
    await tx.cashMovement.createMany({
      data: [{
        businessId: input.businessId,
        saleId: intent.saleId ?? null,
        type: "in",
        amount: intent.monto,
        // "promesa" is intentionally outside PaymentMethodValue enum —
        // CashMovement.paymentMethod is String? and accepts extended values.
        paymentMethod: "promesa",
        description,
        date: now,
        clientMessageId: `promesa-confirm-${input.paymentIntentId}`,
      }],
      skipDuplicates: true,
    });

    return {
      outcome: "confirmed" as const,
      paymentIntentId: intent.id,
      promesaExpectedAt: input.expectedAt,
    };
  });

  if (result.outcome !== "confirmed") {
    cloudLog({
      severity: "INFO",
      component: "System",
      action: "PROMESA_CONFIRM_SKIPPED",
      a2a_transfer: false,
      message: `confirmPromesaPaymentUseCase: skipped — ${result.outcome}`,
      data: { paymentIntentId: input.paymentIntentId, outcome: result.outcome },
    });
    return result;
  }

  // Fire-and-forget: fiscal receipt + shipment + WhatsApp + push.
  // Same chain used by confirmPaymentIntentUseCase for checkout_pro_link.
  // runPostConfirmSideEffects branches on pi.metodo — "promesa" will fall
  // through to the notifyCustomerOnConfirm (QR/legacy) path which is correct
  // for a manual promise confirmation.
  runPostConfirmSideEffects(result.paymentIntentId, input.businessId).catch(() => {
    // Swallowed — cloudLog records errors inside runPostConfirmSideEffects.
  });

  // ── Audit write — best-effort ────────────────────────────────────────────
  // If recordCriticalWriteEvent throws AFTER the transaction has committed,
  // the PI + CashMovement already exist in the DB and we must NOT fail the
  // tool call. The CriticalWriteEvent cron provides fallback recovery for
  // missed audit rows.
  try {
    await recordCriticalWriteEvent({
      client: prisma,
      businessId: input.businessId,
      actorUserId: input.actorUserId,
      routeScope: CONFIRM_PROMESA_ACTION.routeScope,
      actionType: CONFIRM_PROMESA_ACTION.actionType,
      resourceType: CONFIRM_PROMESA_ACTION.resourceType,
      resourceId: result.paymentIntentId,
      summary: `Promesa de pago registrada — vence ${input.expectedAt.toISOString().slice(0, 10)}`,
      payload: {
        paymentIntentId: result.paymentIntentId,
        expectedAt: input.expectedAt.toISOString(),
        reason: input.reason ?? null,
      },
    });
  } catch (auditErr) {
    cloudLog({
      severity: "WARNING",
      component: "System",
      action: "CONFIRM_PROMESA_AUDIT_WRITE_FAILED",
      a2a_transfer: false,
      message: "recordCriticalWriteEvent failed after transaction commit — PI committed, audit row missed",
      businessId: input.businessId,
      data: {
        paymentIntentId: result.paymentIntentId,
        error: auditErr instanceof Error ? auditErr.message : String(auditErr),
      },
    });
  }

  return result;
}
