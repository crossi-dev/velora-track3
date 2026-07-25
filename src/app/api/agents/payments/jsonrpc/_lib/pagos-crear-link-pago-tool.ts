import "server-only";
// pagos-crear-link-pago-tool.ts — createTool-wrapped factory for pagos.crear_link_pago.
//
// Interface reshape: raw `new FunctionTool({...})` → createTool factory.
// Behaviour: UNCHANGED — execute logic lives in pagos-crear-link-pago.execute.ts
// to honour the 250-line limit for new server files. All MP/MODO behaviour,
// idempotency, shipping guard, orphan-heal, and HTTP/direct writeback are
// preserved verbatim.
//
// Namespace: pagos.crear_link_pago
// Market shape sources (pre-verified):
//   Square CreatePaymentLink: https://developer.squareup.com/reference/square/checkout-api/create-payment-link
//   MP CreatePayment: https://www.mercadopago.com.ar/developers/en/reference/online-payments/checkout-api-payments/create-payment/post
//
// AR gap noted: cuotas/installments is AR-specific — not in this pass.

import { z } from "zod";
import { Type } from "@google/genai";
import type { Schema } from "@google/genai";
import { createTool } from "@/lib/adk/tools/_shared/create-tool";
import { executeCrearLinkPago } from "./pagos-crear-link-pago.execute";
import type { PaymentToolCtx } from "./payments-agent-types";

// ── Zod input schema ──────────────────────────────────────────────────────────
// IMPORTANT: Do NOT use .positive() or .int().positive() — zod-to-json-schema
// emits exclusiveMinimum:true (JSON Schema Draft 4 boolean form) which Vertex AI
// Schema validator rejects, silently dropping the entire function declaration list.
// Use .min(N) instead (produces numeric minimum: N, not a boolean flag).

const CrearLinkPagoInput = z.object({
  customerId: z.string().min(1),
  items: z.array(
    z.object({
      productId: z.string().min(1),
      quantity: z.number().min(1),
      unitPriceOverride: z.number().min(0).optional(),
    }),
  ).min(1),
  description: z.string().min(1),
  shippingRequired: z.boolean().optional(),
  destinationPostalCode: z.string().optional(),
  destinationAddress: z.string().optional(),
  preQuotedShippingCostARS: z.number().min(0).optional(),
});

// ── Genai Schema (LLM calling convention) ─────────────────────────────────────
// Mirrors createPaymentLinkParams from payments-link-schema.ts exactly — same
// field names and descriptions so existing Supervisor prompts keep working.

const CREAR_LINK_PAGO_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    customerId: {
      type: Type.STRING,
      description:
        "Canonical customer ID in Velora's DB. " +
        "The Supervisor must resolve this from the customer name BEFORE delegating to the Payments Agent.",
    },
    items: {
      type: Type.ARRAY,
      description: "Products included in the sale. At least one item required.",
      minItems: "1",
      items: {
        type: Type.OBJECT,
        properties: {
          productId: {
            type: Type.STRING,
            description:
              "Canonical product ID in Velora's DB. Must come from a prior catalog lookup — never invent IDs.",
          },
          quantity: {
            type: Type.INTEGER,
            description: "Quantity sold. Must be a positive integer.",
          },
          unitPriceOverride: {
            type: Type.NUMBER,
            description:
              "Unit price override. Use ONLY when the owner explicitly stated a price " +
              "different from the catalog. Omit to use the DB catalog price.",
          },
        },
        required: ["productId", "quantity"],
      },
    },
    description: {
      type: Type.STRING,
      description: "Payment description shown to the customer (e.g. 'Venta Velora - 3 filtros de aire')",
    },
    shippingRequired: {
      type: Type.BOOLEAN,
      description: "Set true when the owner requests a payment link that includes shipping costs.",
    },
    destinationPostalCode: {
      type: Type.STRING,
      description:
        "Destination postal code (4-5 digits). Required when shippingRequired=true and the customer has no saved postal code.",
    },
    destinationAddress: {
      type: Type.STRING,
      description: "Street address of the recipient. Used for shipment.create snapshot.",
    },
    preQuotedShippingCostARS: {
      type: Type.NUMBER,
      description:
        "Pre-quoted shipping cost in ARS. When present (>0), the tool uses this value directly " +
        "and skips the Logística re-quote. Pass through from the Customer Agent when the shipping " +
        "was already quoted upstream. Set shippingRequired=true alongside this field.",
    },
  },
  required: ["customerId", "items", "description"],
};

// ── Factory ────────────────────────────────────────────────────────────────────

export function buildCrearLinkPagoTool(ctx: PaymentToolCtx) {
  return createTool({
    name: "pagos.crear_link_pago",
    description:
      "Creates a Sale + Invoice + payment link atomically, then returns a checkout URL " +
      "to share with the customer via WhatsApp. Invariant: every payment link has a Sale. " +
      "The Supervisor must resolve customerId and productId values before calling this tool.",
    schema: CREAR_LINK_PAGO_SCHEMA,
    inputSchema: CrearLinkPagoInput,
    backend: ctx,
    execute: ({ input, backend }) => executeCrearLinkPago(input, backend),
  });
}
