import "server-only";
// pagos-registrar-venta-promesa-tool.ts — createTool-wrapped factory for pagos.registrar_venta_promesa.
//
// Interface reshape: raw `new FunctionTool({...})` → createTool factory.
// Behaviour: UNCHANGED — all atomic Sale+PI creation, shipping validation, and the
// HTTP/direct writeback toggle are preserved verbatim from payments-register-promesa-sale-tool.ts.
//
// Namespace: pagos.registrar_venta_promesa
// Market shape note: this is an AR-specific one-shot tool (Sale + Invoice + PI in one
// atomic transaction). Square/MP market shapes split these into separate calls.
// The compound operation is deliberate for the AR deferred-payment pattern
// — no market analog exists. Name reflects the AR domain, not a market primitive.
//
// Sources (pre-verified):
//   Square CreatePayment: https://developer.squareup.com/reference/square/payments-api/create-payment
//   MP CreatePayment: https://www.mercadopago.com.ar/developers/en/reference/online-payments/checkout-api-payments/create-payment/post

import { z } from "zod";
import { Type } from "@google/genai";
import type { Schema } from "@google/genai";
import { createTool } from "@/lib/adk/tools/_shared/create-tool";
import { cloudLog } from "@/lib/cloud-logger";
import { registerPromesaSaleUseCase } from "@/app/api/payment-intents/_lib/register-promesa-sale-use-case";
import { callPromesaSaleEndpoint, isPromesaSaleOverHttpEnabled } from "./register-promesa-sale-writeback";
import type { PromesaAgentCtx } from "./payments-promesa-tool";

// ── Zod input schema ──────────────────────────────────────────────────────────
// NOTE: Do NOT use .positive() or .int().positive() — emits exclusiveMinimum:true
// (Draft 4 boolean) which Vertex AI rejects. Use .min(N) instead.

const RegistrarVentaPromesaInput = z.object({
  customerId: z.string().min(1),
  items: z.array(
    z.object({
      productId: z.string().min(1),
      quantity: z.number().min(1),
      unitPriceOverride: z.number().min(0).optional(),
    }),
  ).min(1),
  expectedAt: z.string().min(1),
  reason: z.string().optional(),
  shipping: z.object({
    courier: z.enum(["andreani", "oca"]),
    cost: z.number().min(0),
    shippingAddressId: z.string().optional(),
  }).optional(),
});

// ── Genai Schema (LLM calling convention) ─────────────────────────────────────
// Mirrors registerPromesaSaleParams from payments-register-promesa-sale-tool.ts exactly.

const REGISTRAR_VENTA_PROMESA_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    customerId: {
      type: Type.STRING,
      description:
        "ID canónico del cliente en la DB de Velora. " +
        "El Supervisor resuelve el customerId a partir del nombre antes de delegar.",
    },
    items: {
      type: Type.ARRAY,
      description: "Lista de productos vendidos. Al menos un ítem requerido.",
      minItems: "1",
      items: {
        type: Type.OBJECT,
        properties: {
          productId: {
            type: Type.STRING,
            description:
              "ID canónico del producto en la DB de Velora. Debe venir del lookup previo del catálogo — nunca inventes IDs.",
          },
          quantity: {
            type: Type.INTEGER,
            description: "Cantidad vendida. Debe ser un entero mayor a cero.",
          },
          unitPriceOverride: {
            type: Type.NUMBER,
            description:
              "Precio unitario a usar en lugar del precio del catálogo. " +
              "Usalo SOLO cuando el owner explícitamente indicó un precio diferente. " +
              "Si no se especifica, el sistema usa el precio del producto en la DB.",
          },
        },
        required: ["productId", "quantity"],
      },
    },
    expectedAt: {
      type: Type.STRING,
      description:
        "Fecha ISO (YYYY-MM-DD o ISO 8601) en la que el owner espera cobrar. " +
        "Si el owner no da fecha exacta, calculá 30 días desde hoy.",
    },
    reason: {
      type: Type.STRING,
      description: "Nota libre del owner. Opcional. Ej: 'Juan — paga en junio'.",
    },
    shipping: {
      type: Type.OBJECT,
      description:
        "Datos de envío. Si está presente, dispara creación de envío Andreani/OCA " +
        "en el post-confirm y agrega línea de flete en el Invoice.",
      properties: {
        courier: {
          type: Type.STRING,
          enum: ["andreani", "oca"],
          description: "Proveedor de envío activo para el tenant. 'andreani' o 'oca'.",
        },
        cost: {
          type: Type.NUMBER,
          description: "Costo de envío en ARS, declarado por el owner o cotizado upstream.",
        },
        shippingAddressId: {
          type: Type.STRING,
          description:
            "ID de la dirección de envío del cliente. " +
            "Si se omite, se usa customer.shippingAddressId por defecto.",
        },
      },
      required: ["courier", "cost"],
    },
  },
  required: ["customerId", "items", "expectedAt"],
};

// ── Factory ────────────────────────────────────────────────────────────────────

export function buildRegistrarVentaPromesaTool(ctx: PromesaAgentCtx) {
  return createTool({
    name: "pagos.registrar_venta_promesa",
    description:
      "Registra una venta completa como promesa de pago en un solo paso: " +
      "crea Sale + SaleItems + Invoice + PaymentIntent de forma atómica, " +
      "y dispara la cadena post-confirm (comprobante PDF + WhatsApp). " +
      "Usalo cuando el owner combina detalle de venta + promesa en un mensaje " +
      "(ítems + cantidades + cliente + fecha de cobro esperada). " +
      "A diferencia de pagos.crear_pago, este tool NO requiere un " +
      "PaymentIntent preexistente — crea todo desde cero con datos de la DB.",
    schema: REGISTRAR_VENTA_PROMESA_SCHEMA,
    inputSchema: RegistrarVentaPromesaInput,
    backend: ctx,
    execute: async ({ input, backend }) => {
      const { customerId, items, expectedAt, reason, shipping } = input;

      // Validate shipping params before any DB call.
      if (shipping !== undefined) {
        if (shipping.courier !== "andreani" && shipping.courier !== "oca") {
          return { error: { code: "invalid_courier", message: `Courier '${shipping.courier}' no es válido. Usá 'andreani' o 'oca'.` } };
        }
        if (shipping.cost < 0) {
          return { error: { code: "invalid_shipping_cost", message: "El costo de envío no puede ser negativo." } };
        }
        // M2: plausibility cap — prevents hallucinated freight from inflating the total.
        const MAX_SHIPPING_ARS = 99_999;
        if (shipping.cost > MAX_SHIPPING_ARS) {
          return { error: { code: "shipping_cost_out_of_range", message: `El costo de envío (${shipping.cost} ARS) supera el máximo aceptable.` } };
        }
      }

      if (!backend.businessId || !backend.actorUserId) {
        cloudLog({
          severity: "WARNING",
          component: "A2A",
          action: "PAYMENTS_TOOL_REGISTRAR_PROMESA_MISSING_CTX",
          a2a_transfer: false,
          message: "pagos.registrar_venta_promesa: missing businessId or actorUserId",
          data: { hasBusinessId: Boolean(backend.businessId), hasActorUserId: Boolean(backend.actorUserId) },
        });
        return { error: { code: "missing_context", message: "Missing businessId or actorUserId" } };
      }

      const expectedAtDate = new Date(expectedAt);
      if (isNaN(expectedAtDate.getTime())) {
        return {
          error: {
            code: "invalid_expected_at",
            message: `'${expectedAt}' no es una fecha válida. Usá formato ISO (ej: 2026-06-30).`,
          },
        };
      }

      const useCaseInput = {
        businessId: backend.businessId, actorUserId: backend.actorUserId,
        customerId, items, expectedAt: expectedAtDate, reason, shipping,
      };
      const result = isPromesaSaleOverHttpEnabled()
        ? await callPromesaSaleEndpoint(useCaseInput)
        : await registerPromesaSaleUseCase(useCaseInput);

      if (result.outcome === "created") {
        return {
          success: true as const,
          paymentIntentId: result.paymentIntentId,
          saleId: result.saleId,
          grandTotal: result.grandTotal,
          expectedAt: expectedAtDate.toISOString(),
          message: "Venta + promesa registradas. Comprobante PDF y WhatsApp disparados.",
          currency: "ARS" as const,
        };
      }

      if (result.outcome === "replayed") {
        return {
          success: true as const,
          replayed: true as const,
          paymentIntentId: result.paymentIntentId,
          saleId: result.saleId,
          message: "Esta venta ya fue registrada (idempotente).",
          currency: "ARS" as const,
        };
      }

      if (result.outcome === "business_not_found") {
        cloudLog({
          severity: "ERROR",
          component: "A2A",
          action: "PAYMENTS_TOOL_REGISTRAR_PROMESA_BUSINESS_NOT_FOUND",
          a2a_transfer: false,
          message: "pagos.registrar_venta_promesa: business row not found inside transaction",
          businessId: backend.businessId,
          data: { businessId: backend.businessId },
        });
        return { error: { code: "business_not_found", message: "No se encontró el negocio. Es posible que haya sido eliminado." } };
      }

      if (result.outcome === "customer_not_found") {
        cloudLog({
          severity: "WARNING",
          component: "A2A",
          action: "PAYMENTS_TOOL_REGISTRAR_PROMESA_CUSTOMER_NOT_FOUND",
          a2a_transfer: false,
          message: `pagos.registrar_venta_promesa: customer not found: ${customerId}`,
          businessId: backend.businessId,
          data: { customerId },
        });
        return {
          error: {
            code: "customer_not_found",
            message: "No encontré ese cliente en la base del negocio. Verificá el customerId o pedile al owner que lo cargue primero.",
          },
        };
      }

      if (result.outcome === "product_not_found" || result.outcome === "wrong_business") {
        cloudLog({
          severity: "WARNING",
          component: "A2A",
          action: "PAYMENTS_TOOL_REGISTRAR_PROMESA_PRODUCT_INVALID",
          a2a_transfer: false,
          message: `pagos.registrar_venta_promesa: product ${result.outcome} — ${result.productId}`,
          businessId: backend.businessId,
          data: { outcome: result.outcome, productId: result.productId },
        });
        return {
          error: {
            code: result.outcome,
            message: result.outcome === "product_not_found"
              ? `No encontré el producto ${result.productId} en el catálogo de este negocio.`
              : `El producto ${result.productId} no pertenece a este negocio.`,
          },
        };
      }

      if (result.outcome === "invalid_qty") {
        return {
          error: {
            code: "invalid_qty",
            message: `La cantidad para el producto ${result.productId} debe ser un entero mayor a cero.`,
          },
        };
      }

      if (result.outcome === "unit_price_out_of_range") return { error: { code: "unit_price_out_of_range", message: `El precio unitario para el producto ${result.productId} supera 10× el precio de catálogo — revisalo.` } };
      if (result.outcome === "invalid_total") return { error: { code: "invalid_total", message: "El total de la venta es 0 o inválido (precio de producto en 0). Revisá los precios antes de registrar." } };

      // outcome === "insufficient_stock"
      cloudLog({
        severity: "WARNING",
        component: "A2A",
        action: "PAYMENTS_TOOL_REGISTRAR_PROMESA_INSUFFICIENT_STOCK",
        a2a_transfer: false,
        message: `pagos.registrar_venta_promesa: insufficient stock — ${result.productName}`,
        businessId: backend.businessId,
        data: { productName: result.productName, available: result.available },
      });
      return {
        error: {
          code: "insufficient_stock",
          message: `Stock insuficiente para "${result.productName}". Disponible: ${result.available}.`,
        },
      };
    },
  });
}
