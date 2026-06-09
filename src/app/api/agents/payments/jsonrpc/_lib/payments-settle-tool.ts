// payments-settle-tool.ts — ADK FunctionTool for settle_promesa_payment.
// Registered in adk-payments-agent.ts alongside confirm_promesa_payment.
//
// Triggered when the real cash arrives for a previously-recorded promesa:
//   "ya me pagó la promesa", "me llegó el dinero", "saldé la promesa",
//   "cobré la cuenta corriente".
//
// Creates a real CashMovement (paymentMethod = transferencia|efectivo|mp)
// linked to the original PaymentIntent via clientMessageId
// "promesa-settle-{piId}".

import { z } from "zod/v3";
import { FunctionTool } from "@google/adk";
import { cloudLog } from "@/lib/cloud-logger";
import { settlePromesaUseCase } from "@/app/api/payment-intents/_lib/settle-promesa-use-case";
import type { SettlePaymentMethod } from "@/app/api/payment-intents/_lib/settle-promesa-use-case";

import type { BizSnapshot } from "./payments-agent-types";

export type SettlePromesaAgentCtx = {
  businessId: string | null;
  actorUserId: string | null;
  bizSnapshot?: BizSnapshot | null;
};

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

const settlePromesaParams = z.object({
  originalPaymentIntentId: z
    .string()
    .describe(
      "ID del PaymentIntent que fue registrado como promesa de pago y que ahora se está saldando.",
    ),
  paymentMethod: z
    .enum(["transferencia", "efectivo", "mp"])
    .describe(
      "Método por el que llegó el dinero real: transferencia, efectivo, o mp (MercadoPago).",
    ),
  amount: z
    .number()
    .optional()
    .describe(
      "Solo pasá amount si el dueño indicó un monto DISTINTO al de la promesa original (pago parcial). Si no lo menciona, OMITILO — el sistema usa el monto original de la promesa.",
    ),
  reason: z
    .string()
    .optional()
    .describe("Nota libre (ej: 'Juan transfirió el 26/06'). Opcional."),
});

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

export function buildSettlePromesaPaymentTool(ctx: SettlePromesaAgentCtx) {
  return new FunctionTool({
    name: "settle_promesa_payment",
    description:
      "Registra que el dinero de una promesa de pago anterior finalmente llegó. " +
      "Usalo cuando el owner dice que ya cobró o recibió el pago que estaba diferido. " +
      "Crea un CashMovement real (efectivo/transferencia/mp) vinculado a la promesa original. " +
      "Palabras clave: 'ya me pagó la promesa', 'me llegó el dinero de la promesa', " +
      "'saldé la promesa', 'cobré la cuenta corriente'. " +
      "Requiere el originalPaymentIntentId de la promesa, el monto y el método de cobro.",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ADK ships a nested zod copy with nominally distinct types; cast at the SDK boundary only.
    parameters: settlePromesaParams as any,
    execute: async (input) => {
      try {
        const { originalPaymentIntentId, paymentMethod, amount, reason } =
          input as z.infer<typeof settlePromesaParams>;

        if (!ctx.businessId || !ctx.actorUserId) {
          cloudLog({
            severity: "WARNING",
            component: "A2A",
            action: "PAYMENTS_TOOL_SETTLE_MISSING_CTX",
            a2a_transfer: false,
            message: "settle_promesa_payment: missing businessId or actorUserId",
            data: {
              hasBusinessId: Boolean(ctx.businessId),
              hasActorUserId: Boolean(ctx.actorUserId),
            },
          });
          return { error: "missing_context", currency: "ARS" as const };
        }

        // amount is optional — when provided it is an explicit owner override (partial
        // payment). The use-case will validate it and fall back to DB PI.monto when absent.
        if (amount !== undefined && amount <= 0) {
          return {
            error: "invalid_amount",
            message: "El monto debe ser mayor a 0.",
            currency: "ARS" as const,
          };
        }

        const result = await settlePromesaUseCase({
          originalPaymentIntentId,
          businessId: ctx.businessId,
          actorUserId: ctx.actorUserId,
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
            action: "PAYMENTS_TOOL_SETTLE_NOT_FOUND",
            a2a_transfer: false,
            message: `settle_promesa_payment: PI not found: ${originalPaymentIntentId}`,
            businessId: ctx.businessId,
            data: { originalPaymentIntentId },
          });
          return {
            error: "payment_intent_not_found",
            message: "No encontré ese PaymentIntent. Verificá el ID.",
            currency: "ARS" as const,
          };
        }

        if (result.outcome === "wrong_metodo") {
          return {
            error: "wrong_metodo",
            message: `Ese PaymentIntent tiene metodo="${result.metodo}", no es una promesa.`,
            currency: "ARS" as const,
          };
        }

        if (result.outcome === "invalid_promesa_monto") {
          return {
            error: "invalid_promesa_monto",
            message: "Esa promesa tiene un monto inválido (0). No puedo registrar el cobro — revisá la promesa original.",
            currency: "ARS" as const,
          };
        }

        if (result.outcome === "amount_too_large") {
          return {
            error: "amount_too_large",
            message: "El monto indicado supera el doble del monto original de la promesa. Verificá el monto con el owner.",
            currency: "ARS" as const,
          };
        }

        // outcome === "wrong_state"
        return {
          error: "wrong_state",
          message: `El PaymentIntent está en estado "${result.estado}" y no se puede saldar.`,
          currency: "ARS" as const,
        };
      } catch (err) {
        cloudLog({
          severity: "ERROR",
          component: "A2A",
          action: "PAYMENTS_TOOL_SETTLE_THREW",
          a2a_transfer: false,
          message: "settle_promesa_payment: unhandled throw in execute",
          data: { error: err instanceof Error ? err.message : String(err) },
        });
        return {
          error: "tool_execution_failed",
          message: err instanceof Error ? err.message : String(err),
          currency: "ARS" as const,
        };
      }
    },
  });
}
