import "server-only";
// catalogo-precios-tipo-cliente-tool.ts — Price-tier management tool.
//
// Tool: catalogo.precios_por_tipo_cliente
//   Actions: upsert_tier / assign_customer / list_tiers / query_price
//
// Source (industry reference, verified HTTP 200):
//   Lightspeed Retail price books:
//     https://x-series-support.lightspeedhq.com/hc/en-us/articles/360000051606
//   Square CatalogPricingRule:
//     https://developer.squareup.com/reference/square/objects/CatalogPricingRule
//
// Execute body is split into _lib/catalogo-precios-execute.ts to stay under the
// 300-line file limit (project conventions: Code Size Contract).
//
// Data model (migration 20260602100000_add_product_price_tier):
//   ProductPriceTier        — tier per tenant (mayorista, minorista, vip…)
//   ProductPriceTierEntry   — price override per (tier, product)
//   Customer.priceTierId    — optional FK to assign a customer to a tier

import { z } from "zod";
import { Type } from "@google/genai";
import type { Schema } from "@google/genai";
import { createTool } from "./_shared/create-tool";
import {
  executeListTiers,
  executeQueryPrice,
  executeUpsertTier,
  executeAssignCustomer,
} from "./_lib/catalogo-precios-execute";

// ── Backend port (exported so the execute sibling can import it) ──────────────

export interface CatalogoPrecionTipoClienteBackend {
  businessId: string;
  actorUserId: string;
  actorEmployeeId: string | null;
}

// ── Zod input (exported so the execute sibling can reference action branches) ─

export const PreciosTipoClienteInput = z.discriminatedUnion("action", [
  // upsert_tier: create or update a price tier + its product overrides.
  z.object({
    action: z.literal("upsert_tier"),
    tierLabel: z
      .string()
      .min(1)
      .max(64, "El nombre del tier no puede superar 64 caracteres.")
      .describe("Nombre del tier, ej: 'mayorista', 'minorista', 'vip'."),
    description: z.string().max(500).optional().describe("Descripción opcional."),
    overrides: z
      .array(
        z.object({
          productName: z
            .string()
            .min(1)
            .describe("Nombre del producto (búsqueda case-insensitive)."),
          price: z
            .number()
            .finite()
            .min(0, "El precio no puede ser negativo.")
            .describe("Precio override para este tier."),
        }),
      )
      .optional()
      .default([])
      .describe("Productos con precio especial para este tier."),
    idempotency_key: z.string().min(1),
  }),
  // assign_customer: link a customer to a tier.
  z.object({
    action: z.literal("assign_customer"),
    customerName: z.string().min(1),
    tierLabel: z.string().min(1),
    idempotency_key: z.string().min(1),
  }),
  // list_tiers: all tiers for this business.
  z.object({
    action: z.literal("list_tiers"),
  }),
  // query_price: effective price for a customer + product pair.
  z.object({
    action: z.literal("query_price"),
    customerName: z.string().min(1),
    productName: z.string().min(1),
  }),
]);

export type PreciosTipoClienteInput = z.infer<typeof PreciosTipoClienteInput>;

// ── Genai schema ──────────────────────────────────────────────────────────────

const PRECIOS_TIPO_CLIENTE_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    action: {
      type: Type.STRING,
      description:
        "Operación: 'upsert_tier' (crear/actualizar tier con precios), " +
        "'assign_customer' (asignar cliente a un tier), " +
        "'list_tiers' (listar todos los tiers del negocio), " +
        "'query_price' (consultar precio efectivo de un producto para un cliente).",
    },
    tierLabel: {
      type: Type.STRING,
      description:
        "[upsert_tier / assign_customer] Nombre del tier: 'mayorista', 'minorista', 'vip', etc.",
    },
    description: {
      type: Type.STRING,
      description: "[upsert_tier] Descripción opcional del tier.",
    },
    overrides: {
      type: Type.ARRAY,
      description:
        "[upsert_tier] Lista de { productName, price } con precios especiales.",
      items: {
        type: Type.OBJECT,
        properties: {
          productName: {
            type: Type.STRING,
            description: "Nombre del producto.",
          },
          price: {
            type: Type.NUMBER,
            description: "Precio override (positivo).",
          },
        },
      },
    },
    customerName: {
      type: Type.STRING,
      description: "[assign_customer / query_price] Nombre del cliente.",
    },
    productName: {
      type: Type.STRING,
      description: "[query_price] Nombre del producto.",
    },
    idempotency_key: {
      type: Type.STRING,
      description:
        "[upsert_tier / assign_customer] Clave única de idempotencia.",
    },
  },
  required: ["action"],
};

// ── Factory ────────────────────────────────────────────────────────────────────

export function createPreciosTipoClienteTool(
  backend: CatalogoPrecionTipoClienteBackend,
) {
  return createTool({
    name: "catalogo.precios_por_tipo_cliente",
    description:
      "Gestiona precios diferenciados por tipo de cliente (mayorista, minorista, vip…). " +
      "'upsert_tier' — crea o actualiza un tier con precios especiales por producto; " +
      "'assign_customer' — asigna un cliente a un tier; " +
      "'list_tiers' — lista los tiers del negocio con sus precios; " +
      "'query_price' — precio efectivo de un producto para un cliente (override del tier o base). " +
      "Confirmá con el dueño antes de ejecutar upsert_tier o assign_customer.",
    schema: PRECIOS_TIPO_CLIENTE_SCHEMA,
    inputSchema: PreciosTipoClienteInput,
    backend,
    execute: async ({ input, backend: b }) => {
      if (input.action === "list_tiers") {
        return executeListTiers(b.businessId);
      }
      if (input.action === "query_price") {
        return executeQueryPrice(b.businessId, input.customerName, input.productName);
      }
      if (input.action === "upsert_tier") {
        return executeUpsertTier(b, input);
      }
      return executeAssignCustomer(b, input);
    },
  });
}
