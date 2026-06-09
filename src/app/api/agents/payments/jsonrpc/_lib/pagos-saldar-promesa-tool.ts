import "server-only";
// pagos-saldar-promesa-tool.ts — createTool-wrapped factory for pagos.saldar_promesa.
//
// Interface reshape: raw `new FunctionTool({...})` → createTool factory.
// Behaviour: UNCHANGED — all settle logic, amount validation, payment method enum,
// and use-case delegation are preserved verbatim from payments-settle-tool.ts.
//
// Namespace: pagos.saldar_promesa
// Market shape note: settling a deferred payment (promesa) is AR-specific.
// Closest analog in Square/MP is a separate payment creation after a prior authorization,
// but the semantics differ. This tool records that previously-deferred cash arrived.
//
// Sources (pre-verified):
//   Square CreatePayment: https://developer.squareup.com/reference/square/payments-api/create-payment
//   MP CreatePayment: https://www.mercadopago.com.ar/developers/en/reference/online-payments/checkout-api-payments/create-payment/post

import { z } from "zod";
import { Type } from "@google/genai";
import type { Schema } from "@google/genai";
import { createTool } from "@/lib/adk/tools/_shared/create-tool";
import { cloudLog } from "@/lib/cloud-logger";
import { settlePromesaUseCase } from "@/app/api/payment-intents/_lib/settle-promesa-use-case";
import type { SettlePaymentMethod } from "@/app/api/payment-intents/_lib/settle-promesa-use-case";
import type { SettlePromesaAgentCtx } from "./payments-settle-tool";

// ── Zod input schema ──────────────────────────────────────────────────────────
// NOTE: Do NOT use .positive() — emits exclusiveMinimum:true (Draft 4 boolean).
// Use .min(0.01) instead.

const SaldarPromesaInput = z.object({
  originalPaymentIntentId: z.string().min(1),
  paymentMethod: z.enum(["transferencia", "efectivo", "mp"]),
  amount: z.number().min(0.01),
  reason: z.string().optional(),
});

// ── Genai Schema (LLM calling convention) ─────────────────────────────────────

const SALDAR_PROMESA_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    originalPaymentIntentId: {
      type: Type.STRING,
      description:
        "ID del PaymentIntent que fue registrado como promesa de pago y que ahora se está saldando.",
    },
    paymentMethod: {
      type: Type.STRING,
      enum: ["transferencia", "efectivo", "mp"],
      description:
        "Método por el que llegó el dinero real: transferencia, efectivo, o mp (MercadoPago).",
    },
    amount: {
      type: Type.NUMBER,
      description:
        "Monto recibido en ARS. Debe coincidir con el monto original de la promesa salvo acuerdo distinto.",
    },
    reason: {
      type: Type.STRING,
      description: "Nota libre (ej: 'Juan transfirió el 26/06'). Opcional.",
    },
  },
  required: ["originalPaymentIntentId", "paymentMethod", "amount"],
};

// ── Factory ────────────────────────────────────────────────────────────────────

export function buildSaldarPromesaTool(ctx: SettlePromesaAgentCtx) {
  return createTool({
    name: "pagos.saldar_promesa",
    description:
      "Registra que el dinero de una promesa de pago anterior finalmente llegó. " +
      "Usalo cuando el owner dice que ya cobró o recibió el pago que estaba diferido. " +
      "Crea un CashMovement real (efectivo/transferencia/mp) vinculado a la promesa original. " +
      "Palabras clave: 'ya me pagó la promesa', 'me llegó el dinero de la promesa', " +
      "'saldé la promesa', 'cobré la cuenta corriente'. " +
      "Requiere el originalPaymentIntentId de la promesa, el monto y el método de cobro.",
    schema: SALDAR_PROMESA_SCHEMA,
    inputSchema: SaldarPromesaInput,
    backend: ctx,
    execute: async ({ input, backend }) => {
      const { originalPaymentIntentId, paymentMethod, amount, reason } = input;

      if (!backend.businessId || !backend.actorUserId) {
        cloudLog({
          severity: "WARNING",
          component: "A2A",
          action: "PAYMENTS_TOOL_SALDAR_PROMESA_MISSING_CTX",
          a2a_transfer: false,
          message: "pagos.saldar_promesa: missing businessId or actorUserId",
          data: { hasBusinessId: Boolean(backend.businessId), hasActorUserId: Boolean(backend.actorUserId) },
        });
        return { error: { code: "missing_context", message: "Missing businessId or actorUserId" } };
      }

      if (amount <= 0) {
        return { error: { code: "invalid_amount", message: "El monto debe ser mayor a 0." } };
      }

      const result = await settlePromesaUseCase({
        originalPaymentIntentId,
        businessId: backend.businessId,
        actorUserId: backend.actorUserId,
        paymentMethod: paymentMethod as SettlePaymentMethod,
        amount,
        reason,
      });

      if (result.outcome === "settled") {
        return {
          success: true as const,
          cashMovementId: result.cashMovementId,
          settledAt: result.settledAt.toISOString(),
          message: `Promesa saldada. CashMovement registrado (${paymentMethod}).`,
          currency: "ARS" as const,
        };
      }

      if (result.outcome === "already_settled") {
        return {
          success: true as const,
          replayed: true as const,
          cashMovementId: result.cashMovementId,
          message: "Esta promesa ya fue saldada anteriormente.",
          currency: "ARS" as const,
        };
      }

      if (result.outcome === "not_found") {
        cloudLog({
          severity: "WARNING",
          component: "A2A",
          action: "PAYMENTS_TOOL_SALDAR_PROMESA_NOT_FOUND",
          a2a_transfer: false,
          message: `pagos.saldar_promesa: PI not found: ${originalPaymentIntentId}`,
          businessId: backend.businessId,
          data: { originalPaymentIntentId },
        });
        return { error: { code: "payment_intent_not_found", message: "No encontré ese PaymentIntent. Verificá el ID." } };
      }

      if (result.outcome === "wrong_metodo") {
        return {
          error: {
            code: "wrong_metodo",
            message: `Ese PaymentIntent tiene metodo="${result.metodo}", no es una promesa.`,
          },
        };
      }

      if (result.outcome === "invalid_promesa_monto") {
        return {
          error: {
            code: "invalid_promesa_monto",
            message: "Esa promesa tiene un monto inválido (0). No puedo registrar el cobro — revisá la promesa original.",
          },
        };
      }

      if (result.outcome === "amount_too_large") {
        return {
          error: {
            code: "amount_too_large",
            message: "El monto indicado supera el doble del monto original de la promesa. Verificá el monto con el owner.",
          },
        };
      }

      // outcome === "wrong_state"
      return {
        error: {
          code: "wrong_state",
          message: `El PaymentIntent está en estado "${result.estado}" y no se puede saldar.`,
        },
      };
    },
  });
}
