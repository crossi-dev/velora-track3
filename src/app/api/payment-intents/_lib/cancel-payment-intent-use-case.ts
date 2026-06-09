// Cancel use-case del PaymentIntent.
//
// Transiciones permitidas:
//   - pending    → cancelled  (always)
//   - expired    → cancelled  (ONLY when isWebhookCancel=true, i.e. system actors)
//
// Rationale: a rejection webhook from MP/MODO can arrive after the in-store
// 2-min expiry fires (MP retry window up to 72h). The PI is already "expired"
// in Velora but the buyer was rejected at the provider level — we must reflect
// "cancelled" so the owner sees accurate UI state. Manual/owner cancel of an
// expired PI stays rejected (no UI surprise). Mirrors the isWebhookConfirm
// allow-list in confirm-transaction.ts:73.
//
// No genera CashMovement porque el intent nunca llegó a cobrado.
// El campo `cancelledAt` no existe en el schema (se decidió no agregar columna
// en este slice); solo actualizamos `estado`.
//
// Patrón canónico: idempotency begin → transaction → complete + audit, o
// release en error. Mirror exacto del confirm/refund flow.

import { prisma } from "@/lib/prisma";
import { recordCriticalWriteEvent } from "@/infrastructure/shared/critical-write-audit";
import {
  beginIdempotentMutation,
  completeIdempotentMutation,
  releaseIdempotentMutation,
} from "@/app/api/_lib/idempotency";
import { getServerActionMeta } from "@/app/api/_lib/mutation-contract";

const CANCEL_ACTION = getServerActionMeta("payment_intent.cancel");

// System actors that may cancel an already-expired PI (mirrors isWebhookConfirm
// allow-list in payment-intent-use-case.ts:232).
const WEBHOOK_CANCEL_ACTORS = new Set([
  "system-mp-webhook",
  "system-modo-webhook",
  "system-mp-reconcile",
]);

export interface CancelPaymentIntentInput {
  businessId: string;
  actorUserId: string;
  actorEmployeeId: string | null;
  paymentIntentId: string;
  idempotencyKey: string;
  // Optional: route ACTION_META threaded through. Defaults to CANCEL_ACTION.
  actionMeta?: { actionType: string; routeScope: string; resourceType: string };
}

export type CancelPaymentIntentResult =
  | { outcome: "cancelled"; paymentIntentId: string }
  | { outcome: "not_found" }
  | { outcome: "not_cancellable"; estado: string }
  | { outcome: "replayed"; status: number; body: unknown }
  | { outcome: "idempotency_missing" }
  | { outcome: "idempotency_conflict" }
  | { outcome: "idempotency_in_flight" };

export async function cancelPaymentIntentUseCase(
  input: CancelPaymentIntentInput,
): Promise<CancelPaymentIntentResult> {
  const resolvedCancelAction = input.actionMeta ?? CANCEL_ACTION;
  const idempotency = await beginIdempotentMutation({
    client: prisma,
    businessId: input.businessId,
    actionType: resolvedCancelAction.actionType,
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
    const result = await prisma.$transaction(async (tx) => {
      const intent = await tx.paymentIntent.findFirst({
        where: { id: input.paymentIntentId, businessId: input.businessId },
        select: { id: true, estado: true, monto: true },
      });
      if (!intent) return { outcome: "not_found" as const };

      const isWebhookCancel = WEBHOOK_CANCEL_ACTORS.has(input.actorUserId);
      const cancellable =
        intent.estado === "pending" ||
        (intent.estado === "expired" && isWebhookCancel);

      if (!cancellable) {
        return { outcome: "not_cancellable" as const, estado: intent.estado };
      }
      await tx.paymentIntent.update({
        where: { id: intent.id },
        data: { estado: "cancelled" },
      });
      return { outcome: "cancelled" as const, paymentIntentId: intent.id, monto: Number(intent.monto) };
    });

    if (result.outcome !== "cancelled") {
      await releaseIdempotentMutation({ client: prisma, recordId });
      return result;
    }

    const responseBody = { ok: true, paymentIntentId: result.paymentIntentId };

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
      routeScope: resolvedCancelAction.routeScope,
      actionType: resolvedCancelAction.actionType,
      resourceType: resolvedCancelAction.resourceType,
      resourceId: result.paymentIntentId,
      summary: `Cobro QR cancelado por empleado (intent ${result.paymentIntentId})`,
      payload: { paymentIntentId: result.paymentIntentId },
    });

    return { outcome: "cancelled", paymentIntentId: result.paymentIntentId };
  } catch (error) {
    await releaseIdempotentMutation({ client: prisma, recordId });
    throw error;
  }
}
