// payments-register-promesa-sale-tool.ts — ADK FunctionTool for register_promesa_sale.
//
// One-shot flow: Sale + SaleItems + Invoice + PaymentIntent in a single atomic
// transaction, followed by fire-and-forget PDF receipt + WhatsApp.
//
// Grounding contract (Stripe/ADK 2026/NABAOS arXiv 2603.10060):
//   - customerId and productId are canonical DB IDs — never names resolved by the LLM.
//   - All monetary values come from DB rows. unitPriceOverride is allowed but logged.
//   - The Supervisor resolves IDs upstream; this tool does tenant-scoped validation.

import { FunctionTool } from "@google/adk";
import { Type } from "@google/genai";
import type { Schema } from "@google/genai";
import { cloudLog } from "@/lib/cloud-logger";
import { registerPromesaSaleUseCase } from "@/app/api/payment-intents/_lib/register-promesa-sale-use-case";
import { callPromesaSaleEndpoint, isPromesaSaleOverHttpEnabled } from "./register-promesa-sale-writeback";
import type { PromesaAgentCtx } from "./payments-promesa-tool";

// ---------------------------------------------------------------------------
// Input schema (raw @google/genai Schema — bypasses zod-to-json-schema)
// ---------------------------------------------------------------------------
// History (2026-05-26): this tool's original Zod v3 schema produced
// `exclusiveMinimum: true` (Draft 4 boolean form) from
// `z.number().int().positive()` and left nested `additionalProperties: false`
// objects (ADK's postProcess only strips the root). Both are rejected by
// Vertex AI's Schema validator, which silently dropped the entire function
// declaration list — Gemini then returned an empty candidate (no content,
// no function call), drainEvents saw zero events, and the route fell back
// to "Sin respuesta del modelo." for every Payments turn (Path Juan block,
// 2026-05-26). Using the raw `Schema` type from `@google/genai` mirrors
// Google's own canonical 2026 example for ADK FunctionTool parameters and
// skips zod-to-json-schema entirely. Runtime validation lives in execute().
const registerPromesaSaleParams: Schema = {
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

// Runtime input shape — mirrors the Schema fields above. Used by execute().
type RegisterPromesaSaleInput = {
  customerId: string;
  items: Array<{ productId: string; quantity: number; unitPriceOverride?: number }>;
  expectedAt: string;
  reason?: string;
  shipping?: { courier: "andreani" | "oca"; cost: number; shippingAddressId?: string };
};

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

export function buildRegisterPromesaSaleTool(ctx: PromesaAgentCtx) {
  return new FunctionTool({
    name: "register_promesa_sale",
    description:
      "Registra una venta completa como promesa de pago en un solo paso: " +
      "crea Sale + SaleItems + Invoice + PaymentIntent de forma atómica, " +
      "y dispara la cadena post-confirm (comprobante PDF + WhatsApp). " +
      "Usalo cuando el owner combina detalle de venta + promesa en un mensaje " +
      "(ítems + cantidades + cliente + fecha de cobro esperada). " +
      "A diferencia de confirm_promesa_payment, este tool NO requiere un " +
      "PaymentIntent preexistente — crea todo desde cero con datos de la DB. " +
      "Los valores monetarios se resuelven SIEMPRE desde el catálogo de productos; " +
      "unitPriceOverride es solo para cuando el owner indica un precio distinto.",
    parameters: registerPromesaSaleParams,
    execute: async (input) => {
      try {
        const { customerId, items, expectedAt, reason, shipping } =
          input as RegisterPromesaSaleInput;

        // Validate shipping params before any DB call.
        if (shipping !== undefined) {
          if (shipping.courier !== "andreani" && shipping.courier !== "oca") {
            return { error: "invalid_courier", message: `Courier '${shipping.courier}' no es válido. Usá 'andreani' o 'oca'.`, currency: "ARS" as const };
          }
          if (shipping.cost < 0) {
            return { error: "invalid_shipping_cost", message: "El costo de envío no puede ser negativo.", currency: "ARS" as const };
          }
          // M2: plausibility cap — prevents hallucinated freight from inflating the total.
          const MAX_SHIPPING_ARS = 99_999;
          if (shipping.cost > MAX_SHIPPING_ARS) {
            return { error: "shipping_cost_out_of_range", message: `El costo de envío (${shipping.cost} ARS) supera el máximo aceptable.`, currency: "ARS" as const };
          }
        }

        if (!ctx.businessId || !ctx.actorUserId) {
          cloudLog({
            severity: "WARNING",
            component: "A2A",
            action: "PAYMENTS_TOOL_REGISTER_PROMESA_MISSING_CTX",
            a2a_transfer: false,
            message: "register_promesa_sale: missing businessId or actorUserId",
            data: { hasBusinessId: Boolean(ctx.businessId), hasActorUserId: Boolean(ctx.actorUserId) },
          });
          return { error: "missing_context", currency: "ARS" as const };
        }

        const expectedAtDate = new Date(expectedAt);
        if (isNaN(expectedAtDate.getTime())) {
          return {
            error: "invalid_expected_at",
            message: `'${expectedAt}' no es una fecha válida. Usá formato ISO (ej: 2026-06-30).`,
            currency: "ARS" as const,
          };
        }

        const useCaseInput = { businessId: ctx.businessId, actorUserId: ctx.actorUserId, customerId, items, expectedAt: expectedAtDate, reason, shipping };
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
            message:
              "Venta + promesa registradas. Comprobante PDF y WhatsApp disparados.",
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
            action: "PAYMENTS_TOOL_REGISTER_PROMESA_BUSINESS_NOT_FOUND",
            a2a_transfer: false,
            message: "register_promesa_sale: business row not found inside transaction",
            businessId: ctx.businessId,
            data: { businessId: ctx.businessId },
          });
          return {
            error: "business_not_found",
            message: "No se encontró el negocio. Es posible que haya sido eliminado.",
            currency: "ARS" as const,
          };
        }

        if (result.outcome === "customer_not_found") {
          cloudLog({
            severity: "WARNING",
            component: "A2A",
            action: "PAYMENTS_TOOL_REGISTER_PROMESA_CUSTOMER_NOT_FOUND",
            a2a_transfer: false,
            message: `register_promesa_sale: customer not found: ${customerId}`,
            businessId: ctx.businessId,
            data: { customerId },
          });
          return {
            error: "customer_not_found",
            message:
              "No encontré ese cliente en la base del negocio. " +
              "Verificá el customerId o pedile al owner que lo cargue primero.",
            currency: "ARS" as const,
          };
        }

        if (result.outcome === "product_not_found" || result.outcome === "wrong_business") {
          cloudLog({
            severity: "WARNING",
            component: "A2A",
            action: "PAYMENTS_TOOL_REGISTER_PROMESA_PRODUCT_INVALID",
            a2a_transfer: false,
            message: `register_promesa_sale: product ${result.outcome} — ${result.productId}`,
            businessId: ctx.businessId,
            data: { outcome: result.outcome, productId: result.productId },
          });
          return {
            error: result.outcome,
            message:
              result.outcome === "product_not_found"
                ? `No encontré el producto ${result.productId} en el catálogo de este negocio.`
                : `El producto ${result.productId} no pertenece a este negocio.`,
            currency: "ARS" as const,
          };
        }

        if (result.outcome === "invalid_qty") return { error: "invalid_qty", message: `La cantidad para el producto ${result.productId} debe ser un entero mayor a cero.`, currency: "ARS" as const };
        if (result.outcome === "unit_price_out_of_range") return { error: "unit_price_out_of_range", message: `El precio unitario para el producto ${result.productId} supera 10× el precio de catálogo — revisalo.`, currency: "ARS" as const };

        if (result.outcome === "invalid_total") return { error: "invalid_total", message: "El total de la venta es 0 o inválido (precio de producto en 0). Revisá los precios antes de registrar.", currency: "ARS" as const };

        // outcome === "insufficient_stock"
        cloudLog({
          severity: "WARNING",
          component: "A2A",
          action: "PAYMENTS_TOOL_REGISTER_PROMESA_INSUFFICIENT_STOCK",
          a2a_transfer: false,
          message: `register_promesa_sale: insufficient stock — ${result.productName}`,
          businessId: ctx.businessId,
          data: { productName: result.productName, available: result.available },
        });
        return {
          error: "insufficient_stock",
          message: `Stock insuficiente para "${result.productName}". Disponible: ${result.available}.`,
          currency: "ARS" as const,
        };
      } catch (err) {
        cloudLog({
          severity: "ERROR",
          component: "A2A",
          action: "PAYMENTS_TOOL_REGISTER_PROMESA_THREW",
          a2a_transfer: false,
          message: "register_promesa_sale: unhandled throw in execute",
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
