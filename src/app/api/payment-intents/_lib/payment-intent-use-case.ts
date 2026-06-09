// Payment-intent use-case shared por:
//   - POST /api/payment-intents/create     (intent inicial, QR pendiente)
//   - POST /api/payment-intents/confirm    (confirmación manual del cobro)
//   - chat handler `cobro_qr` del business-assistant (invoca el create
//     in-process — evita roundtrip HTTP)
//
// Slice 1 = tracer bullet: el QR es un placeholder estático servido desde
// /static/qr-placeholder.svg. Slices posteriores reemplazan el QR fake por
// el QR dinámico real de Mercado Pago via OAuth + webhook.
//
// Idempotencia: cada acción usa `beginIdempotentMutation` con la unique
// (businessId, actionType, idempotencyKey) — el insert atómico arbitra
// concurrencia (P2002 → readback → replay/conflict).

import { prisma } from "@/lib/prisma";
import { recordCriticalWriteEvent } from "@/infrastructure/shared/critical-write-audit";
import {
  beginIdempotentMutation,
  completeIdempotentMutation,
  releaseIdempotentMutation,
} from "@/app/api/_lib/idempotency";
import { getServerActionMeta } from "@/app/api/_lib/mutation-contract";
import { runConfirmTransaction } from "./confirm-transaction";
import { runPostConfirmSideEffects } from "./payment-intent-post-confirm";

// Canonical action metadata — used internally and accepted from callers so the
// route's ACTION_META binding is threaded through rather than discarded (void).
const CREATE_ACTION = getServerActionMeta("payment_intent.create");
const CONFIRM_ACTION = getServerActionMeta("payment_intent.confirm");

export const QR_PLACEHOLDER_URL = "/static/qr-placeholder.svg";

// Slice 3 — Timeout 2 min anti-comprobante-falso. Vale para qr y alias.
// El cliente del chat dispara un countdown desde createdAt; pasado este
// margen el confirm devuelve 410 EXPIRED y el intent queda en "expired".
export const PAYMENT_INTENT_EXPIRY_MS = 2 * 60 * 1000;

function computeExpiresAt(now: Date = new Date()): Date {
  return new Date(now.getTime() + PAYMENT_INTENT_EXPIRY_MS);
}

export interface CreatePaymentIntentInput {
  businessId: string;
  actorUserId: string;
  actorEmployeeId: string | null;
  saleId: string | null;
  monto: number;
  metodo: string; // slice 1: siempre "qr_dynamic_fake"
  idempotencyKey: string;
  // Cliente resuelto por NLU al tipear "cobro 5000 a Carlos". Se persiste
  // en PaymentIntent para que el post-confirm pueda enviar el recibo WA
  // sin necesitar un saleId (caso cobro previo a la venta).
  matchedCustomerId?: string | null;
  // Optional: route ACTION_META threaded through so the audit record uses the
  // route's binding rather than the internal constant. Defaults to CREATE_ACTION.
  actionMeta?: { actionType: string; routeScope: string; resourceType: string };
}

export type CreatePaymentIntentResult =
  | { outcome: "created"; intent: PaymentIntentSummary }
  | { outcome: "replayed"; status: number; body: unknown }
  | { outcome: "idempotency_missing" }
  | { outcome: "idempotency_conflict" }
  | { outcome: "idempotency_in_flight" }
  | { outcome: "sale_not_found" };

export interface PaymentIntentSummary {
  paymentIntentId: string;
  saleId: string | null;
  monto: number;
  metodo: string;
  estado: string;
  qrPlaceholderUrl: string;
  // Slice 3 — ISO string del expiresAt (createdAt + 2 min). Null para rows
  // legacy creados antes de la migration; el cliente trata null como "no expira".
  expiresAt: string | null;
}

export async function createPaymentIntentUseCase(
  input: CreatePaymentIntentInput,
): Promise<CreatePaymentIntentResult> {
  const resolvedCreateAction = input.actionMeta ?? CREATE_ACTION;
  const idempotency = await beginIdempotentMutation({
    client: prisma,
    businessId: input.businessId,
    actionType: resolvedCreateAction.actionType,
    idempotencyKey: input.idempotencyKey,
    requestBody: { saleId: input.saleId, monto: input.monto, metodo: input.metodo },
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
    // Tenant-scope guard: verify saleId belongs to the actor's business before
    // writing. Without this, a cross-tenant saleId would be silently accepted.
    if (input.saleId !== null) {
      const sale = await prisma.sale.findFirst({
        where: { id: input.saleId, businessId: input.businessId },
        select: { id: true },
      });
      if (!sale) {
        await releaseIdempotentMutation({ client: prisma, recordId });
        return { outcome: "sale_not_found" };
      }
    }

    const expiresAt = computeExpiresAt();
    const created = await prisma.paymentIntent.create({
      data: {
        businessId: input.businessId,
        saleId: input.saleId,
        monto: input.monto,
        metodo: input.metodo,
        estado: "pending",
        idempotencyKey: input.idempotencyKey,
        expiresAt,
        ...(input.matchedCustomerId ? { matchedCustomerId: input.matchedCustomerId } : {}),
        ...(input.actorEmployeeId ? { createdByEmployeeId: input.actorEmployeeId } : {}),
      },
      select: {
        id: true,
        saleId: true,
        monto: true,
        metodo: true,
        estado: true,
        expiresAt: true,
      },
    });

    const summary: PaymentIntentSummary = {
      paymentIntentId: created.id,
      saleId: created.saleId,
      monto: Number(created.monto),
      metodo: created.metodo,
      estado: created.estado,
      qrPlaceholderUrl: QR_PLACEHOLDER_URL,
      expiresAt: created.expiresAt ? created.expiresAt.toISOString() : null,
    };

    await completeIdempotentMutation({
      client: prisma,
      recordId,
      responseStatus: 201,
      responseBody: summary,
    });

    await recordCriticalWriteEvent({
      client: prisma,
      businessId: input.businessId,
      actorUserId: input.actorUserId,
      actorEmployeeId: input.actorEmployeeId,
      routeScope: resolvedCreateAction.routeScope,
      actionType: resolvedCreateAction.actionType,
      resourceType: resolvedCreateAction.resourceType,
      resourceId: created.id,
      summary: `Cobro QR pendiente por $${summary.monto}`,
      payload: {
        paymentIntentId: created.id,
        saleId: input.saleId,
        monto: summary.monto,
        metodo: summary.metodo,
      },
    });

    return { outcome: "created", intent: summary };
  } catch (error) {
    await releaseIdempotentMutation({ client: prisma, recordId });
    throw error;
  }
}

export interface ConfirmPaymentIntentInput {
  businessId: string;
  actorUserId: string;
  actorEmployeeId: string | null;
  paymentIntentId: string;
  idempotencyKey: string;
  // Optional: route ACTION_META threaded through. Defaults to CONFIRM_ACTION.
  actionMeta?: { actionType: string; routeScope: string; resourceType: string };
}

export type ConfirmPaymentIntentResult =
  | { outcome: "confirmed"; paymentIntentId: string; saleId: string | null }
  | { outcome: "not_found" }
  | { outcome: "already_confirmed" }
  | { outcome: "expired"; paymentIntentId: string }
  | { outcome: "replayed"; status: number; body: unknown }
  | { outcome: "idempotency_missing" }
  | { outcome: "idempotency_conflict" }
  | { outcome: "idempotency_in_flight" };

export async function confirmPaymentIntentUseCase(
  input: ConfirmPaymentIntentInput,
): Promise<ConfirmPaymentIntentResult> {
  const resolvedConfirmAction = input.actionMeta ?? CONFIRM_ACTION;
  const idempotency = await beginIdempotentMutation({
    client: prisma,
    businessId: input.businessId,
    actionType: resolvedConfirmAction.actionType,
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
    const result = await runConfirmTransaction({
      ...input,
      // The reconcile cron path ("system-mp-reconcile") is the recovery fallback
      // when the direct webhook fails (cold start, schema mismatch, MP retry
      // exhaustion). It must share the same expired-intent reopen privilege as
      // the webhook actor — otherwise a late confirmation is silently lost.
      // Root cause of Juan stuck-pending 2026-05-26 — webhook 14:37 errored
      // on missing CashMovement.clientMessageId column, reconcile is now the
      // only path that can recover the already-approved MP payment.
      isWebhookConfirm: ["system-mp-webhook", "system-modo-webhook", "system-mp-reconcile"].includes(
        input.actorUserId ?? "",
      ),
    });

    if (result.outcome !== "confirmed") {
      await releaseIdempotentMutation({ client: prisma, recordId });
      return result;
    }

    const responseBody = {
      ok: true,
      paymentIntentId: result.paymentIntentId,
      saleId: result.saleId,
    };

    await completeIdempotentMutation({
      client: prisma,
      recordId,
      responseStatus: 200,
      responseBody,
    });

    // Side effects are now the caller's responsibility.
    // - Cloud Tasks worker path: awaits runPostConfirmSideEffects AFTER this
    //   use-case returns, keeping the HTTP connection open so Cloud Tasks can
    //   retry on failure. See src/app/api/internal/tasks/confirm-payment/route.ts.
    // - Manual owner confirm path: caller awaits runPostConfirmSideEffects
    //   directly after calling this use-case.
    // The previous fire-and-forget was removed to close the Cloud Run kill gap:
    // https://cloud.google.com/tasks/docs/creating-http-target-tasks#handler

    await recordCriticalWriteEvent({
      client: prisma,
      businessId: input.businessId,
      actorUserId: input.actorUserId,
      actorEmployeeId: input.actorEmployeeId,
      routeScope: resolvedConfirmAction.routeScope,
      actionType: resolvedConfirmAction.actionType,
      resourceType: resolvedConfirmAction.resourceType,
      resourceId: result.paymentIntentId,
      summary: `Cobro QR confirmado (intent ${result.paymentIntentId})`,
      payload: {
        paymentIntentId: result.paymentIntentId,
        saleId: result.saleId,
      },
    });

    return result;
  } catch (error) {
    await releaseIdempotentMutation({ client: prisma, recordId });
    throw error;
  }
}

// La transacción atómica vive en `confirm-transaction.ts` para mantener
// este archivo bajo el hard limit de 300 LOC. Slice 3 agregó el branch de
// expiry, que sumaba ~15 LOC.
