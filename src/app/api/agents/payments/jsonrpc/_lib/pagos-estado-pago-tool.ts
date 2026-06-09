import "server-only";
// pagos-estado-pago-tool.ts — createTool-wrapped factory for pagos.estado_pago.
//
// Interface reshape: raw `new FunctionTool({...})` → createTool factory.
// Behaviour: UNCHANGED — all status resolution logic, customer-name fuzzy lookup,
// and the PaymentsBackend seam are preserved verbatim from payments-status-tool.ts.
//
// Namespace: pagos.estado_pago
// Market shape sources (pre-verified):
//   Square CreatePayment: https://developer.squareup.com/reference/square/payments-api/create-payment
//   MP CreatePayment: https://www.mercadopago.com.ar/developers/en/reference/online-payments/checkout-api-payments/create-payment/post
//
// SEAM: execute() delegates to PaymentsBackend.getPaymentStatus — the adapter
// already owns the DB + provider status resolution. This avoids the inline
// prisma + resolveCustomerIdByName duplication that was in the original tool.

import { z } from "zod";
import { Type } from "@google/genai";
import type { Schema } from "@google/genai";
import { createTool } from "@/lib/adk/tools/_shared/create-tool";
import { createPaymentsBackend } from "@/lib/mcp/_lib/payments-backend.factory";
import type { BizSnapshot } from "./payments-agent-types";

// ── Zod input schema ──────────────────────────────────────────────────────────
// NOTE: Do NOT add .refine(...) — ADK's isZodObject detector requires the raw
// ZodObject typeName. refine() wraps in ZodEffects, causing ADK to ship the
// raw zod internals to Vertex AI (HTTP 400). Cross-field validation is enforced
// in execute() via the missing_lookup_key branch.

const EstadoPagoInput = z.object({
  paymentIntentId: z.string().optional(),
  customerName: z.string().optional(),
});

// ── Genai Schema (LLM calling convention) ─────────────────────────────────────

const ESTADO_PAGO_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    paymentIntentId: {
      type: Type.STRING,
      description:
        "The Velora paymentIntentId returned by pagos.crear_link_pago. " +
        "Optional when customerName is provided.",
    },
    customerName: {
      type: Type.STRING,
      description:
        "Customer name to look up the most recent open payment intent for. " +
        "Use when the owner asks by customer name instead of by ID.",
    },
  },
};

// ── Factory ────────────────────────────────────────────────────────────────────

export function buildEstadoPagoTool(ctx: {
  businessId: string | null;
  actorUserId: string | null;
  turnId: string;
  bizSnapshot?: BizSnapshot | null;
}) {
  return createTool({
    name: "pagos.estado_pago",
    description:
      "Checks the current status of a payment. Accepts a Velora paymentIntentId OR a customer name " +
      "(e.g. 'Juan') — when a name is given, resolves the most recent open payment intent for that customer. " +
      "Returns status: pending | approved | rejected | error.",
    schema: ESTADO_PAGO_SCHEMA,
    inputSchema: EstadoPagoInput,
    backend: ctx,
    execute: async ({ input, backend }) => {
      if (!backend.businessId) {
        return { error: { code: "missing_business_context", message: "Missing business context" } };
      }

      const backendInstance = createPaymentsBackend();
      const result = await backendInstance.getPaymentStatus({
        tenantId: backend.businessId,
        paymentIntentId: input.paymentIntentId,
        customerName: input.customerName,
      });

      if (result.domainError) {
        switch (result.domainError) {
          case "missing_lookup_key":
            return { error: { code: "missing_lookup_key", message: "Necesito el paymentIntentId o el nombre del cliente." } };
          case "customer_not_found":
            return { error: { code: "customer_not_found", message: `No encontré al cliente "${input.customerName}". Verificá el nombre o usá el paymentIntentId.` } };
          case "no_payment_intent_found":
            return { error: { code: "no_payment_intent_found", message: `No encontré ningún cobro para "${input.customerName}".` } };
          case "payment_intent_not_found":
            return { error: { code: "no_payment_intent_found", message: "No encontré el cobro indicado." } };
          case "status_lookup_failed":
            return {
              error: { code: "status_lookup_failed", message: "Error al consultar el estado del pago." },
              paymentIntentId: result.paymentIntentId ?? input.paymentIntentId,
            };
        }
      }

      return {
        sandbox: false,
        paymentIntentId: result.paymentIntentId!,
        customerName: input.customerName ?? null,
        providerRef: result.providerRef ?? null,
        status: result.status!,
        currency: "ARS" as const,
      };
    },
  });
}
