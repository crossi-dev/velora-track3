// Use-case: settle a promesa de pago — records that the deferred cash actually
// arrived. Accounts-receivable accrual pattern (industry standard):
//
//   1. confirm_promesa: debit AR (receivable now), credit Revenue.
//   2. settle_promesa (this file): debit Cash, credit AR — closes the loop.
//
// A new CashMovement is created with:
//   - type "in", real paymentMethod (transferencia | efectivo | mp)
//   - clientMessageId "promesa-settle-{originalPaymentIntentId}" — idempotency
//     dedup via the partial unique index on CashMovement.clientMessageId.
//
// The original PaymentIntent is NOT mutated — it remains confirmed/promesa.
// Callers (the settle tool + the cron query) identify un-settled promesas by
// the absence of a CashMovement whose clientMessageId starts with
// "promesa-settle-{piId}".

import { prisma } from "@/lib/prisma";
import { cloudLog } from "@/lib/cloud-logger";
import { recordCriticalWriteEvent } from "@/infrastructure/shared/critical-write-audit";
import { getServerActionMeta } from "@/app/api/_lib/mutation-contract";

const SETTLE_PROMESA_ACTION = getServerActionMeta("payment_intent.settle_promesa");

export type SettlePaymentMethod = "transferencia" | "efectivo" | "mp";

export interface SettlePromesaInput {
  originalPaymentIntentId: string;
  businessId: string;
  actorUserId: string;
  paymentMethod: SettlePaymentMethod;
  /**
   * Amount collected in ARS.
   * When omitted, the use-case uses PI.monto from the DB (DB-first default).
   * Supply only for partial / explicit-override payments where the owner
   * stated a different amount than the original promesa.
   */
  amount?: number;
  reason?: string;
}

export type SettlePromesaResult =
  | { outcome: "settled"; cashMovementId: string; settledAt: Date }
  | { outcome: "already_settled"; cashMovementId: string }
  | { outcome: "not_found" }
  | { outcome: "wrong_metodo"; metodo: string }
  | { outcome: "wrong_state"; estado: string }
  | { outcome: "amount_too_large" }
  | { outcome: "invalid_promesa_monto" };

export async function settlePromesaUseCase(
  input: SettlePromesaInput,
): Promise<SettlePromesaResult> {
  const now = new Date();
  const clientMessageId = `promesa-settle-${input.originalPaymentIntentId}`;

  // ── Validate original PaymentIntent ────────────────────────────────────────
  const intent = await prisma.paymentIntent.findFirst({
    where: { id: input.originalPaymentIntentId, businessId: input.businessId },
    select: { id: true, metodo: true, estado: true, saleId: true, monto: true },
  });

  if (!intent) {
    cloudLog({
      severity: "WARNING",
      component: "Payments",
      action: "SETTLE_PROMESA_NOT_FOUND",
      a2a_transfer: false,
      message: `settlePromesaUseCase: PaymentIntent not found`,
      data: { paymentIntentId: input.originalPaymentIntentId },
      businessId: input.businessId,
    });
    return { outcome: "not_found" };
  }

  if (intent.metodo !== "promesa") {
    cloudLog({
      severity: "WARNING",
      component: "Payments",
      action: "SETTLE_PROMESA_WRONG_METODO",
      a2a_transfer: false,
      message: `settlePromesaUseCase: PI metodo is "${intent.metodo}", expected "promesa"`,
      data: { paymentIntentId: input.originalPaymentIntentId, metodo: intent.metodo },
      businessId: input.businessId,
    });
    return { outcome: "wrong_metodo", metodo: intent.metodo };
  }

  if (intent.estado !== "confirmed") {
    cloudLog({
      severity: "WARNING",
      component: "Payments",
      action: "SETTLE_PROMESA_WRONG_STATE",
      a2a_transfer: false,
      message: `settlePromesaUseCase: PI estado is "${intent.estado}", expected "confirmed"`,
      data: { paymentIntentId: input.originalPaymentIntentId, estado: intent.estado },
      businessId: input.businessId,
    });
    return { outcome: "wrong_state", estado: intent.estado };
  }

  // ── M1: Amount resolution + plausibility check ────────────────────────────
  // DB-first: when the caller omits amount (the standard settle case — owner
  // just says "ya me pagó la promesa"), we use PI.monto from the DB directly.
  // The LLM-supplied amount is only accepted as an explicit override for
  // partial / adjusted payments where the owner stated a different figure.
  //
  // Zero/negative monto guard: a promesa with monto <= 0 indicates data
  // corruption — there is no numeric basis for a plausibility multiple.
  // Return a distinct outcome so the caller surfaces an accurate message.
  const originalMonto = Number(intent.monto);
  if (originalMonto <= 0) {
    cloudLog({
      severity: "ERROR",
      component: "Payments",
      action: "SETTLE_PROMESA_ZERO_MONTO",
      a2a_transfer: false,
      message: `settlePromesaUseCase: PI.monto is ${originalMonto} (≤0) — corrupt promesa, rejecting with invalid_promesa_monto`,
      data: { paymentIntentId: input.originalPaymentIntentId, suppliedAmount: input.amount, originalMonto },
      businessId: input.businessId,
    });
    return { outcome: "invalid_promesa_monto" };
  }

  // Resolve effective amount: DB monto when caller omits the field (default
  // path), LLM-supplied value only when explicitly provided (partial payment).
  const effectiveAmount = input.amount ?? originalMonto;

  if (effectiveAmount > originalMonto * 2) {
    cloudLog({
      severity: "ERROR",
      component: "Payments",
      action: "SETTLE_PROMESA_AMOUNT_TOO_LARGE",
      a2a_transfer: false,
      message: `settlePromesaUseCase: effectiveAmount ${effectiveAmount} exceeds 2× PI.monto ${originalMonto} — rejected`,
      data: { paymentIntentId: input.originalPaymentIntentId, effectiveAmount, originalMonto, suppliedAmount: input.amount },
      businessId: input.businessId,
    });
    return { outcome: "amount_too_large" };
  }
  if (effectiveAmount > originalMonto * 1.05) {
    cloudLog({
      severity: "WARNING",
      component: "Payments",
      action: "SETTLE_PROMESA_AMOUNT_OVER_MONTO",
      a2a_transfer: false,
      message: `settlePromesaUseCase: effectiveAmount ${effectiveAmount} exceeds PI.monto ${originalMonto} by >5% — settling anyway`,
      data: { paymentIntentId: input.originalPaymentIntentId, effectiveAmount, originalMonto, suppliedAmount: input.amount },
      businessId: input.businessId,
    });
  }

  // ── Idempotency: check if already settled ──────────────────────────────────
  const existing = await prisma.cashMovement.findFirst({
    where: { businessId: input.businessId, clientMessageId },
    select: { id: true },
  });
  if (existing) {
    cloudLog({
      severity: "INFO",
      component: "Payments",
      action: "SETTLE_PROMESA_ALREADY_SETTLED",
      a2a_transfer: false,
      message: `settlePromesaUseCase: already settled — cashMovementId ${existing.id}`,
      data: { paymentIntentId: input.originalPaymentIntentId, cashMovementId: existing.id },
      businessId: input.businessId,
    });
    return { outcome: "already_settled", cashMovementId: existing.id };
  }

  // ── Create settle CashMovement ─────────────────────────────────────────────
  const description =
    `Cobro efectivo de promesa — PI ${input.originalPaymentIntentId}` +
    (input.reason ? ` — ${input.reason}` : "");

  let cashMovementId: string;
  try {
    const cm = await prisma.cashMovement.create({
      data: {
        businessId: input.businessId,
        saleId: intent.saleId ?? null,
        type: "in",
        amount: effectiveAmount,
        paymentMethod: input.paymentMethod,
        description,
        date: now,
        clientMessageId,
      },
      select: { id: true },
    });
    cashMovementId = cm.id;
  } catch (err) {
    // P2002 = duplicate clientMessageId (partial unique index) — race with
    // another concurrent settle call. Re-read and return already_settled.
    const code = (err as { code?: string } | null)?.code;
    if (code === "P2002") {
      const race = await prisma.cashMovement.findFirst({
        where: { businessId: input.businessId, clientMessageId },
        select: { id: true },
      });
      if (race) return { outcome: "already_settled", cashMovementId: race.id };
    }
    throw err;
  }

  await recordCriticalWriteEvent({
    client: prisma,
    businessId: input.businessId,
    actorUserId: input.actorUserId,
    routeScope: SETTLE_PROMESA_ACTION.routeScope,
    actionType: SETTLE_PROMESA_ACTION.actionType,
    resourceType: SETTLE_PROMESA_ACTION.resourceType,
    resourceId: input.originalPaymentIntentId,
    summary: `Promesa de pago saldada — ${input.paymentMethod} $${effectiveAmount}`,
    payload: {
      originalPaymentIntentId: input.originalPaymentIntentId,
      cashMovementId,
      paymentMethod: input.paymentMethod,
      amount: effectiveAmount,
      suppliedAmount: input.amount ?? null,
      reason: input.reason ?? null,
    },
  });

  cloudLog({
    severity: "INFO",
    component: "Payments",
    action: "SETTLE_PROMESA_OK",
    a2a_transfer: false,
    message: `Promesa settled — cashMovementId ${cashMovementId}`,
    data: {
      paymentIntentId: input.originalPaymentIntentId,
      cashMovementId,
      paymentMethod: input.paymentMethod,
      amount: effectiveAmount,
      suppliedAmount: input.amount ?? null,
    },
    businessId: input.businessId,
  });

  return { outcome: "settled", cashMovementId, settledAt: now };
}
