import "server-only";
// FunctionTool wrapper for business_query.
//
// Answers stock, price, and sales questions from the authoritative in-memory
// context (catalog, inventory, pending sales). Mirrors the deterministic
// overrides in intent-handlers/business-query.ts without the HTTP coupling.

import { FunctionTool } from "@google/adk";
import { Type } from "@google/genai";
import type { Schema } from "@google/genai";
import {
  buildInventorySummaryAnswer,
  buildProductStockAnswer,
} from "@/app/api/business-assistant/_lib/handlers/inventory-responses";
import { findProductInfoMatch, cleanupProductName } from "@/app/api/business-assistant/_lib/handlers/inventory-matching";
import { formatMoney, normalizeForMatching } from "@/app/api/business-assistant/_lib/shared";
import type { ProductInfoEntry, AssistantBusinessPromptContext } from "@/app/api/business-assistant/_lib/types";

export interface BusinessQueryToolContext {
  productDirectory: ProductInfoEntry[];
  context: AssistantBusinessPromptContext;
  locale: string;
  business: { name: string; currency: string };
  inventorySummary: { productLines: number; totalUnits: number; totalValue: number };
}

type QueryKind = "stock" | "price" | "inventory_summary" | "general";

const BUSINESS_QUERY_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    query: {
      type: Type.STRING,
      description: "The user's question in natural language.",
    },
    kind: {
      type: Type.STRING,
      enum: ["stock", "price", "inventory_summary", "general"],
      description:
        "Query kind. 'stock' = stock level of a product, 'price' = product price, 'inventory_summary' = full catalog overview, 'general' = other.",
    },
    product_name: {
      type: Type.STRING,
      description: "Product name when kind is 'stock' or 'price'.",
    },
  },
  required: ["query", "kind"],
};

export function createBusinessQueryTool(ctx: BusinessQueryToolContext) {
  return new FunctionTool({
    name: "business_query",
    description:
      "Answer business data questions about stock levels, product prices, or inventory summary. Use for queries like '¿cuánto vale [producto]?', '¿tengo stock de Y?', '¿cómo va el negocio?'. NO usar para envíos ni logística — mandar o enviar algo a un código postal o dirección es call_logistica_agent, no una consulta de precio de producto. Para ventas/reportes usar ventas.consultar_ventas.",
    parameters: BUSINESS_QUERY_SCHEMA,
    execute: async (args: unknown) => {
      const input = args as {
        query: string;
        kind: QueryKind;
        product_name?: string;
      };

      const { kind, product_name } = input;

      if (kind === "inventory_summary") {
        const products = ctx.productDirectory.map((p) => ({
          name: p.name,
          price: p.price,
          stock: p.stock,
        }));
        return {
          answer: buildInventorySummaryAnswer(
            { business: ctx.business, inventorySummary: ctx.inventorySummary, products },
            ctx.locale,
          ),
        };
      }

      if ((kind === "stock" || kind === "price") && product_name) {
        // Apply IR-stopword cleanup before lookup. The LLM sometimes passes a
        // Rioplatense voseo verb like "decime" as product_name when the user
        // says "Decime stock de X" — cleanupProductName strips that leading
        // verb so the lookup works correctly. Same logic as check_stock had.
        const cleaned = cleanupProductName(product_name.trim());
        const normalized = normalizeForMatching(cleaned || product_name);
        const { match, ambiguous } = findProductInfoMatch(normalized, ctx.productDirectory);

        if (ambiguous) {
          return { answer: `Encontré varios productos parecidos a "${product_name}". Decime cuál es.`, ambiguous: true };
        }

        if (!match) {
          return { answer: `No encontré "${product_name}" en el catálogo.`, found: false };
        }

        if (kind === "price") {
          const price = formatMoney(match.price, ctx.business.currency, ctx.locale);
          return { answer: `${match.name} vale ${price}.` };
        }

        return { answer: buildProductStockAnswer(match, ctx.locale), found: true, product: { id: match.id, name: match.name, stock: match.stock } };
      }

      return { answer: null, fallback: true };
    },
  });
}
