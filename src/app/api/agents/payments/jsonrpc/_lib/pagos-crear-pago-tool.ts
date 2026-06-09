import "server-only";
// pagos-crear-pago-tool.ts — createTool-wrapped factory for pagos.crear_pago.
//
// Interface reshape: raw `new FunctionTool({...})` → createTool factory.
// Behaviour: UNCHANGED — all promesa confirmation logic, date validation,
// and use-case delegation are preserved verbatim from payments-promesa-tool.ts.
//
// Namespace: pagos.crear_pago
// Market shape mapping:
//   Square CreatePayment: https://developer.squareup.com/reference/square/payments-api/create-payment
//   MP CreatePayment: https://www.mercadopago.com.ar/developers/en/reference/online-payments/checkout-api-payments/create-payment/post
//
// This tool corresponds to the "deferred payment" (promesa) leg of crear_pago —
// it marks an existing PaymentIntent as confirmed with metodo='promesa'.
// The market shape uses `payment_method` (type + detail); here the method is
// hardcoded to promesa (AR-specific deferred-payment concept). Gap noted.

import { z } from "zod";
import { Type } from "@google/genai";
import type { Schema } from "@google/genai";
import { createTool } from "@/lib/adk/tools/_shared/create-tool";
import { cloudLog } from "@/lib/cloud-logger";
import { confirmPromesaPaymentUseCase } from "@/app/api/payment-intents/_lib/confirm-promesa-use-case";
import type { PromesaAgentCtx } from "./payments-promesa-tool";

// ── Zod input schema ──────────────────────────────────────────────────────────

const CrearPagoInput = z.object({
  paymentIntentId: z.string().min(1),
  expectedAt: z.string().min(1),
  reason: z.string().optional(),
});

// ── Genai Schema (LLM calling convention) ─────────────────────────────────────

const CREAR_PAGO_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    paymentIntentId: {
      type: Type.STRING,
      description:
        "ID del PaymentIntent existente que el owner quiere marcar como promesa de pago.",
    },
    expectedAt: {
      type: Type.STRING,
      description:
        "Fecha ISO (YYYY-MM-DD o ISO 8601) en la que el owner espera que llegue el dinero real. " +
        "Si el owner no da fecha exacta, calculá 30 días desde hoy y pasá ese valor.",
    },
    reason: {
      type: Type.STRING,
      description: "Nota libre del owner (ej: 'Juan me prometió pagar el mes que viene'). Opcional.",
    },
  },
  required: ["paymentIntentId", "expectedAt"],
};

// ── Factory ────────────────────────────────────────────────────────────────────

export function buildCrearPagoTool(ctx: PromesaAgentCtx) {
  return createTool({
    name: "pagos.crear_pago",
    description:
      "Marca un PaymentIntent existente como CONFIRMED con metodo='promesa' " +
      "(pago diferido / cuenta corriente informal). " +
      "Usalo cuando el owner dice que el cliente prometió pagar después, " +
      "sin haber pasado por MercadoPago ni transferencia. " +
      "Dispara la cadena normal: registra cash movement (accrual basis), " +
      "emite comprobante, crea envío Andreani si corresponde, y notifica al owner. " +
      "NO uses esta herramienta si el cliente YA pagó — en ese caso usá confirm_payment.",
    schema: CREAR_PAGO_SCHEMA,
    inputSchema: CrearPagoInput,
    backend: ctx,
    execute: async ({ input, backend }) => {
      const { paymentIntentId, expectedAt, reason } = input;

      if (!backend.businessId || !backend.actorUserId) {
        cloudLog({
          severity: "WARNING",
          component: "A2A",
          action: "PAYMENTS_TOOL_CREAR_PAGO_MISSING_CTX",
          a2a_transfer: false,
          message: "pagos.crear_pago: missing businessId or actorUserId",
          data: { hasBusinessId: Boolean(backend.businessId), hasActorUserId: Boolean(backend.actorUserId) },
        });
        return { error: { code: "missing_context", message: "Missing businessId or actorUserId" } };
      }

      const expectedAtDate = new Date(expectedAt);
      if (isNaN(expectedAtDate.getTime())) {
        cloudLog({
          severity: "WARNING",
          component: "A2A",
          action: "PAYMENTS_TOOL_CREAR_PAGO_INVALID_DATE",
          a2a_transfer: false,
          message: `pagos.crear_pago: invalid expectedAt value: ${expectedAt}`,
          businessId: backend.businessId,
          data: { expectedAt },
        });
        return {
          error: {
            code: "invalid_expected_at",
            message: `'${expectedAt}' no es una fecha válida. Usá formato ISO (ej: 2026-06-30).`,
          },
        };
      }

      const result = await confirmPromesaPaymentUseCase({
        paymentIntentId,
        businessId: backend.businessId,
        actorUserId: backend.actorUserId,
        expectedAt: expectedAtDate,
        reason,
      });

      if (result.outcome === "confirmed") {
        return {
          success: true as const,
          paymentIntentId: result.paymentIntentId,
          expectedAt: result.promesaExpectedAt.toISOString(),
          message: "Promesa registrada. Comprobante + envío disparados.",
          currency: "ARS" as const,
        };
      }

      if (result.outcome === "already_confirmed") {
        return {
          success: true as const,
          replayed: true as const,
          paymentIntentId: result.paymentIntentId,
          message: "Este PaymentIntent ya estaba confirmado.",
          currency: "ARS" as const,
        };
      }

      if (result.outcome === "not_found") {
        cloudLog({
          severity: "WARNING",
          component: "A2A",
          action: "PAYMENTS_TOOL_CREAR_PAGO_NOT_FOUND",
          a2a_transfer: false,
          message: `pagos.crear_pago: PaymentIntent not found: ${paymentIntentId}`,
          businessId: backend.businessId,
          data: { paymentIntentId },
        });
        return { error: { code: "payment_intent_not_found", message: "No encontré ese PaymentIntent. Verificá el ID." } };
      }

      // outcome === "wrong_state"
      cloudLog({
        severity: "WARNING",
        component: "A2A",
        action: "PAYMENTS_TOOL_CREAR_PAGO_WRONG_STATE",
        a2a_transfer: false,
        message: `pagos.crear_pago: PaymentIntent not in pending state: ${paymentIntentId}`,
        businessId: backend.businessId,
        data: { paymentIntentId },
      });
      return {
        error: {
          code: "wrong_state",
          message: "El PaymentIntent no está pendiente y no se puede marcar como promesa.",
        },
      };
    },
  });
}
