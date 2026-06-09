// payments-promesa-tool.ts — ADK FunctionTool for confirm_promesa_payment.
// Registered in adk-payments-agent.ts alongside create_payment_link.
// Subarea C of the "promesa de pago" feature (parallel with A: schema, B: use-case).

import { z } from "zod/v3";
import { FunctionTool } from "@google/adk";
import { cloudLog } from "@/lib/cloud-logger";
import { confirmPromesaPaymentUseCase } from "@/app/api/payment-intents/_lib/confirm-promesa-use-case";

import type { BizSnapshot } from "./payments-agent-types";

export type PromesaAgentCtx = {
  businessId: string | null;
  actorUserId: string | null;
  bizSnapshot?: BizSnapshot | null;
};

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

const confirmPromesaParams = z.object({
  paymentIntentId: z
    .string()
    .describe(
      "ID del PaymentIntent existente que el owner quiere marcar como promesa de pago.",
    ),
  expectedAt: z
    .string()
    .describe(
      "Fecha ISO (YYYY-MM-DD o ISO 8601) en la que el owner espera que llegue el dinero real. " +
        "Si el owner no da fecha exacta, calculá 30 días desde hoy y pasá ese valor.",
    ),
  reason: z
    .string()
    .optional()
    .describe(
      "Nota libre del owner (ej: 'Juan me prometió pagar el mes que viene'). Opcional.",
    ),
});

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

export function buildConfirmPromesaPaymentTool(ctx: PromesaAgentCtx) {
  return new FunctionTool({
    name: "confirm_promesa_payment",
    description:
      "Marca un PaymentIntent existente como CONFIRMED con metodo='promesa' " +
      "(pago diferido / cuenta corriente informal). " +
      "Usalo cuando el owner dice que el cliente prometió pagar después, " +
      "sin haber pasado por MercadoPago ni transferencia. " +
      "Dispara la cadena normal: registra cash movement (accrual basis), " +
      "emite comprobante, crea envío Andreani si corresponde, " +
      "y notifica al owner. " +
      "NO uses esta herramienta si el cliente YA pagó — en ese caso usá confirm_payment.",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ADK ships a nested zod copy with nominally distinct types; cast at the SDK boundary only.
    parameters: confirmPromesaParams as any,
    execute: async (input) => {
      try {
        const { paymentIntentId, expectedAt, reason } = input as z.infer<
          typeof confirmPromesaParams
        >;

        if (!ctx.businessId || !ctx.actorUserId) {
          cloudLog({
            severity: "WARNING",
            component: "A2A",
            action: "PAYMENTS_TOOL_PROMESA_MISSING_CTX",
            a2a_transfer: false,
            message: "confirm_promesa_payment: missing businessId or actorUserId",
            data: {
              hasBusinessId: Boolean(ctx.businessId),
              hasActorUserId: Boolean(ctx.actorUserId),
            },
          });
          return { error: "missing_context", currency: "ARS" as const };
        }

        const expectedAtDate = new Date(expectedAt);
        if (isNaN(expectedAtDate.getTime())) {
          cloudLog({
            severity: "WARNING",
            component: "A2A",
            action: "PAYMENTS_TOOL_PROMESA_INVALID_DATE",
            a2a_transfer: false,
            message: `confirm_promesa_payment: invalid expectedAt value: ${expectedAt}`,
            businessId: ctx.businessId,
            data: { expectedAt },
          });
          return {
            error: "invalid_expected_at",
            message: `'${expectedAt}' no es una fecha válida. Usá formato ISO (ej: 2026-06-30).`,
            currency: "ARS" as const,
          };
        }

        const result = await confirmPromesaPaymentUseCase({
          paymentIntentId,
          businessId: ctx.businessId,
          actorUserId: ctx.actorUserId,
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
            action: "PAYMENTS_TOOL_PROMESA_NOT_FOUND",
            a2a_transfer: false,
            message: `confirm_promesa_payment: PaymentIntent not found: ${paymentIntentId}`,
            businessId: ctx.businessId,
            data: { paymentIntentId },
          });
          return {
            error: "payment_intent_not_found",
            message: "No encontré ese PaymentIntent. Verificá el ID.",
            currency: "ARS" as const,
          };
        }

        // outcome === "wrong_state"
        cloudLog({
          severity: "WARNING",
          component: "A2A",
          action: "PAYMENTS_TOOL_PROMESA_WRONG_STATE",
          a2a_transfer: false,
          message: `confirm_promesa_payment: PaymentIntent not in pending state: ${paymentIntentId}`,
          businessId: ctx.businessId,
          data: { paymentIntentId },
        });
        return {
          error: "wrong_state",
          message:
            "El PaymentIntent no está pendiente y no se puede marcar como promesa.",
          currency: "ARS" as const,
        };
      } catch (err) {
        cloudLog({
          severity: "ERROR",
          component: "A2A",
          action: "PAYMENTS_TOOL_PROMESA_THREW",
          a2a_transfer: false,
          message: "confirm_promesa_payment: unhandled throw in execute",
          data: {
            error: err instanceof Error ? err.message : String(err),
          },
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
