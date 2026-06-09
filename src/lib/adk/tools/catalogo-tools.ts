import "server-only";
// catalogo-tools.ts — Catalog tools built through the createTool factory.
//
// Tool inventory (namespace catalogo.*):
//   1. catalogo.gestionar_producto — create / edit / delete / bulk_price (action discriminant)
//   2. catalogo.consultar_precio   — read price + stock for a product
//
// Source (industry reference, verified HTTP 200):
//   Square UpsertCatalogObject: https://developer.squareup.com/reference/square/catalog-api/upsert-catalog-object
//
// Pattern: intent-emitting (same as ventas-agent-tools.ts Pattern C).
// Mutating actions return a structured intent { intent, data, summary } — the
// downstream RPC handler materialises through the existing idempotent + audited
// mutation pipeline.  consultar_precio is read-only and returns the answer directly.
//
// Tenant isolation: businessId is captured in the backend closure and NEVER read
// from tool args.

import { z } from "zod";
import { Type } from "@google/genai";
import type { Schema } from "@google/genai";
import { createTool } from "./_shared/create-tool";
import { findProductInfoMatch } from "@/app/api/business-assistant/_lib/handlers/inventory-matching";
import { buildProductStockAnswer } from "@/app/api/business-assistant/_lib/handlers/inventory-responses";
import { formatMoney } from "@/app/api/business-assistant/_lib/shared";
import type { ProductInfoEntry } from "@/app/api/business-assistant/_lib/types";

// ── Backend port ───────────────────────────────────────────────────────────────

export interface CatalogoToolsBackend {
  businessId: string;
  /** Catalog snapshot — used by the read-only consultar_precio tool. */
  productDirectory: ProductInfoEntry[];
  currency: string;
  locale: string;
}

// ══════════════════════════════════════════════════════════════════════════════
// 1. catalogo.gestionar_producto
// ══════════════════════════════════════════════════════════════════════════════
//
// Action discriminant covers the four catalog mutations that previously lived
// as separate tools in ventas-agent-tools.ts (create_product, edit_product,
// delete_product, bulk_price_update).  Reshaping through createTool adds:
//   - Zod validation with discriminatedUnion
//   - Standard { code, message } error envelope
//   - Observability via the factory hooks
//
// Intent shape is identical to the original so downstream handler / action-mapper
// logic (supervisor-action-mapper.ts → owner-handler.ts) is unaffected.

const GestionarProductoInput = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create"),
    name: z.string().min(1, "El nombre del producto es obligatorio."),
    price: z.number().finite().min(0, "El precio no puede ser negativo."),
    stock: z
      .number()
      .nullable()
      .describe("Stock inicial; null cuando el dueño no lo mencionó."),
  }),
  z.object({
    action: z.literal("edit"),
    productName: z.string().min(1),
    field: z.enum(["price", "costPrice", "stock", "name"]).describe(
      "Campo a modificar.",
    ),
    value: z
      .union([z.string(), z.number()])
      .describe(
        "Nuevo valor — número para price/costPrice/stock, string para name.",
      ),
  }),
  z.object({
    action: z.literal("delete"),
    productName: z.string().min(1),
  }),
  z.object({
    action: z.literal("bulk_price"),
    amount: z
      .number()
      .finite()
      .positive("El valor del ajuste debe ser positivo."),
    mode: z.enum(["percentage", "absolute"]),
    direction: z.enum(["up", "down", "set"]),
    target: z
      .string()
      .describe(
        "'all' para todo el catálogo, o nombre / categoría de producto.",
      ),
  }),
]);

type GestionarProductoInput = z.infer<typeof GestionarProductoInput>;

const GESTIONAR_PRODUCTO_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    action: {
      type: Type.STRING,
      description:
        "Operación: 'create' (agregar producto), 'edit' (modificar campo), " +
        "'delete' (eliminar producto), 'bulk_price' (ajuste masivo de precios).",
    },
    // create
    name: {
      type: Type.STRING,
      description: "[create] Nombre del nuevo producto.",
    },
    price: {
      type: Type.NUMBER,
      description: "[create] Precio de venta en ARS.",
    },
    stock: {
      type: Type.NUMBER,
      description: "[create] Stock inicial; omitir si no fue mencionado.",
    },
    // edit / delete
    productName: {
      type: Type.STRING,
      description:
        "[edit / delete] Nombre del producto a modificar o eliminar.",
    },
    field: {
      type: Type.STRING,
      description:
        "[edit] Campo a cambiar: price | costPrice | stock | name.",
    },
    value: {
      type: Type.STRING,
      description:
        "[edit] Nuevo valor como string (ej: '1500', 'Coca 500ml').",
    },
    // bulk_price
    amount: {
      type: Type.NUMBER,
      description:
        "[bulk_price] Magnitud del ajuste (porcentaje o valor absoluto, siempre positivo).",
    },
    mode: {
      type: Type.STRING,
      description: "[bulk_price] 'percentage' o 'absolute'.",
    },
    direction: {
      type: Type.STRING,
      description: "[bulk_price] 'up' | 'down' | 'set'.",
    },
    target: {
      type: Type.STRING,
      description:
        "[bulk_price] 'all' para todo el catálogo, o nombre de producto / categoría.",
    },
  },
  required: ["action"],
};

function buildGestionarProductoSummary(
  input: GestionarProductoInput,
): string {
  switch (input.action) {
    case "create":
      return `Crear producto: ${input.name} a $${input.price}${input.stock !== null ? ` con ${input.stock} de stock` : ""}`;
    case "edit":
      return `${input.productName}: ${input.field} → ${input.value}`;
    case "delete":
      return `Eliminar producto: ${input.productName}`;
    case "bulk_price": {
      const dir =
        input.direction === "up"
          ? "Subir"
          : input.direction === "down"
          ? "Bajar"
          : "Setear";
      const suffix = input.mode === "percentage" ? "%" : " $";
      return `${dir} precio ${input.target}: ${input.amount}${suffix}`;
    }
  }
}

export function createGestionarProductoTool(backend: CatalogoToolsBackend) {
  return createTool({
    name: "catalogo.gestionar_producto",
    description:
      "Gestiona el catálogo de productos del negocio. " +
      "Acciones: " +
      "'create' — agrega nuevo producto con nombre, precio y stock opcional; " +
      "'edit' — modifica un campo (price, costPrice, stock o name) de un producto existente; " +
      "'delete' — elimina un producto (solo si no tiene historial de ventas activas); " +
      "'bulk_price' — ajusta precios en porcentaje o valor absoluto para todo el catálogo o un subconjunto. " +
      "Siempre confirmá con el dueño antes de ejecutar mutaciones. " +
      "PROHIBICIÓN: NUNCA inventes un precio. Para field=price o field=costPrice, usá únicamente " +
      "el valor explícitamente declarado por el dueño en el mensaje — jamás copies un precio del catálogo " +
      "ni estimes uno propio.",
    schema: GESTIONAR_PRODUCTO_SCHEMA,
    inputSchema: GestionarProductoInput,
    backend,
    execute: async ({ input }) => {
      // Intent-emitting — no direct mutation. Downstream handler materialises
      // through the existing idempotent + audited mutation pipeline.
      const intent =
        input.action === "bulk_price"
          ? "bulk_price_update"
          : `${input.action}_product`;
      return {
        intent,
        data: input,
        summary: buildGestionarProductoSummary(input),
      };
    },
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// 2. catalogo.consultar_precio
// ══════════════════════════════════════════════════════════════════════════════
//
// Read-only reshape of execute-price-query.ts through createTool.
// Returns the price or stock answer for a product name fragment.
// No idempotency needed — pure read, no side effects.

const ConsultarPrecioInput = z.object({
  product_name: z
    .string()
    .min(1, "Indicá el nombre o fragmento del producto a buscar."),
  query_kind: z
    .enum(["price", "stock"])
    .default("price")
    .describe(
      "'price' para consultar precio de venta, 'stock' para stock disponible.",
    ),
});

const CONSULTAR_PRECIO_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    product_name: {
      type: Type.STRING,
      description: "Nombre o fragmento del producto a consultar.",
    },
    query_kind: {
      type: Type.STRING,
      description:
        "'price' para precio de venta, 'stock' para stock disponible. Default: 'price'.",
    },
  },
  required: ["product_name"],
};

export function createConsultarPrecioTool(backend: CatalogoToolsBackend) {
  return createTool({
    name: "catalogo.consultar_precio",
    description:
      "Consulta el precio o el stock de un producto por nombre. " +
      "Usar para preguntas como '¿cuánto sale la Coca?', '¿qué stock tengo de X?'. " +
      "Si el nombre es ambiguo, retorna los candidatos para que el dueño confirme. " +
      "Nunca inventes precios — siempre usá este tool para leer del catálogo real.",
    schema: CONSULTAR_PRECIO_SCHEMA,
    inputSchema: ConsultarPrecioInput,
    backend,
    execute: async ({ input, backend: b }) => {
      const { match, ambiguous } = findProductInfoMatch(
        input.product_name.trim(),
        b.productDirectory,
      );

      if (ambiguous) {
        return {
          answer: `Encontré varios productos parecidos a "${input.product_name}". ¿Cuál es?`,
          ambiguous: true,
        };
      }

      if (!match) {
        return {
          error: {
            code: "NOT_FOUND",
            message: `No encontré "${input.product_name}" en el catálogo.`,
          },
        };
      }

      if (input.query_kind === "stock") {
        return {
          answer: buildProductStockAnswer(match, b.locale),
          found: true,
          product: { id: match.id, name: match.name, stock: match.stock },
        };
      }

      return {
        answer: `${match.name} vale ${formatMoney(match.price, b.currency, b.locale)}.`,
        found: true,
        product: { id: match.id, name: match.name, price: match.price },
      };
    },
  });
}
