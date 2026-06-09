// Transacción atómica del refund de PaymentIntent — slice 5 ("devolución
// cash V1"). Vive en archivo aparte para mantener `payment-intent-use-case.ts`
// bajo el hard limit de 300 LOC.
//
// V1 simple: el empleado clickeó "Devolver" en una card de cobro confirmado.
// Compensamos la caja con un CashMovement negativo y marcamos el intent como
// refunded. NO toca la API de MP (eso es V2 con refund automático). La
// devolución física al cliente la maneja el empleado fuera del sistema.
//
// Reglas:
//   - solo `confirmed` → `refunded`. Pending/expired/refunded rechazan.
//   - cashMovement.amount = -monto (negativo, type "refund").
//   - sale.status NO se modifica — la venta sigue siendo válida; lo que se
//     compensa es el cash flow.
//
// Idempotency: clientMessageId = "refund-{piId}" is set on every CashMovement
// write. The partial unique index "CashMovement_businessId_clientMessageId_key"
// (migration 20260525900000_add_cashmovement_dedup_key) deduplicates concurrent
// retries via P2002 — treated as a successful no-op (already-refunded race).
// Sources:
//   https://docs.stripe.com/api/idempotent_requests
//   https://www.postgresql.org/docs/current/indexes-partial.html

import { prisma } from "@/lib/prisma";

export interface RefundTxInput {
  businessId: string;
  actorEmployeeId: string | null;
  paymentIntentId: string;
}

export type RefundTxResult =
  | { outcome: "refunded"; paymentIntentId: string; saleId: string | null; monto: number; refundedAt: Date }
  | { outcome: "not_found" }
  | { outcome: "not_confirmed"; estado: string };

export async function runRefundTransaction(
  input: RefundTxInput,
): Promise<RefundTxResult> {
  try {
    return await prisma.$transaction(async (tx) => {
      const intent = await tx.paymentIntent.findFirst({
        where: { id: input.paymentIntentId, businessId: input.businessId },
        select: { id: true, saleId: true, monto: true, estado: true },
      });
      if (!intent) return { outcome: "not_found" as const };
      if (intent.estado !== "confirmed") {
        return { outcome: "not_confirmed" as const, estado: intent.estado };
      }

      const now = new Date();
      await tx.paymentIntent.update({
        where: { id: intent.id },
        data: {
          estado: "refunded",
          refundedAt: now,
          refundedByEmployeeId: input.actorEmployeeId,
        },
      });

      // CashMovement negativo: compensa la entrada que generó el confirm.
      // type "refund" para distinguir de los "income" del confirm en reports.
      // clientMessageId: "refund-{piId}" — stable per intent so the partial
      // unique index "CashMovement_businessId_clientMessageId_key" deduplicates
      // any concurrent retry that races past the estado !== "confirmed" guard.
      const negativeAmount = Number(intent.monto) * -1;
      await tx.cashMovement.create({
        data: {
          businessId: input.businessId,
          saleId: intent.saleId,
          type: "refund",
          description: `Devolución cobro ${intent.id}`,
          amount: negativeAmount,
          date: now,
          clientMessageId: `refund-${intent.id}`,
        },
      });

      return {
        outcome: "refunded" as const,
        paymentIntentId: intent.id,
        saleId: intent.saleId,
        monto: Number(intent.monto),
        refundedAt: now,
      };
    });
  } catch (err) {
    // P2002 on clientMessageId ("refund-{piId}") means a concurrent call already
    // committed the refund CashMovement. The PI estado is now "refunded" — treat
    // as idempotent success by reading back the current state.
    const code = (err as { code?: string } | null)?.code;
    if (code === "P2002") {
      const refunded = await prisma.paymentIntent.findFirst({
        where: { id: input.paymentIntentId, businessId: input.businessId },
        select: { id: true, saleId: true, monto: true, refundedAt: true },
      });
      if (refunded?.refundedAt) {
        return {
          outcome: "refunded" as const,
          paymentIntentId: refunded.id,
          saleId: refunded.saleId,
          monto: Number(refunded.monto),
          refundedAt: refunded.refundedAt,
        };
      }
    }
    throw err;
  }
}
