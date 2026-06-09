import "server-only";
// FunctionTool wrapper for check_stock / stock_query.
//
// Delegates to the same `findProductInfoMatch` + `buildProductStockAnswer`
// that the NLU Fast Path and LLM post-handler already use. ADK calls this
// tool when the agent decides to check stock — the execute function does
// the real lookup against the in-memory product directory passed at
// request time via closure.
//
// Design: tools are factory functions (not singletons) so each request
// can bind its own `productDirectory` snapshot without shared state.

import { FunctionTool } from "@google/adk";
import { Type } from "@google/genai";
import type { Schema } from "@google/genai";
import { findProductInfoMatch, cleanupProductName } from "@/app/api/business-assistant/_lib/handlers/inventory-matching";
import { buildProductStockAnswer, buildInventorySummaryAnswer } from "@/app/api/business-assistant/_lib/handlers/inventory-responses";
import type { ProductInfoEntry } from "@/app/api/business-assistant/_lib/types";

export interface CheckStockToolContext {
  productDirectory: ProductInfoEntry[];
  locale: string;
  business: { name: string; currency: string };
  inventorySummary: { productLines: number; totalUnits: number; totalValue: number };
}

const CHECK_STOCK_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    product_name: {
      type: Type.STRING,
      description:
        "The name or fragment of the product to look up. Leave empty or omit to return the full inventory summary.",
    },
  },
};

export function createCheckStockTool(ctx: CheckStockToolContext) {
  return new FunctionTool({
    name: "check_stock",
    description:
      "Look up the current stock level of a specific product by name, or return the full inventory summary when no product is specified. Use this for questions like '¿cuánto stock tengo de X?' or '¿cuánto inventario tengo?'.",
    parameters: CHECK_STOCK_SCHEMA,
    execute: async (args: unknown) => {
      const input = args as { product_name?: string };
      // Apply IR-stopword cleanup BEFORE lookup. The supervisor sometimes
      // passes a Rioplatense voseo verb like "decime" as product_name when
      // the user says "Decime stock" — cleanupProductName strips that
      // leading verb so we fall through to the full-inventory branch
      // instead of returning 'No encontré "decime"'.
      const productName = cleanupProductName((input?.product_name ?? "").trim());

      if (!productName) {
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

      const { match, ambiguous } = findProductInfoMatch(productName, ctx.productDirectory);

      if (ambiguous) {
        return {
          answer: `Encontré varios productos parecidos a "${productName}". Decime cuál es.`,
          ambiguous: true,
        };
      }

      if (!match) {
        return {
          answer: `No encontré "${productName}" en el catálogo.`,
          found: false,
        };
      }

      return {
        answer: buildProductStockAnswer(match, ctx.locale),
        found: true,
        product: { id: match.id, name: match.name, stock: match.stock },
      };
    },
  });
}
