import "server-only";
// create-tool.example.ts — Proof-of-shape: check_stock re-expressed via createTool.
//
// This is NOT a replacement of check-stock-tool.ts (which stays as-is).
// It exists to validate that createTool's API is ergonomic and correct for
// an existing tool before domain teams use it for new tools.
//
// Key deltas vs the original check-stock-tool.ts:
//   - Name is namespaced: "stock.check_stock" (createTool enforces this).
//   - Input validation via Zod (original used manual `as` cast).
//   - Error path returns { error: { code, message } } (standard envelope).
//   - Backend is typed as CheckStockBackend port — backend-agnostic.
//   - [feat/factory-trust-upgrade] prohibitions seam: the tool now declares its
//     hard constraints via the `prohibitions` field. The factory appends them to
//     the LLM-visible description as a "PROHIBICIONES (no negociables):" block —
//     no per-tool boilerplate needed. This is the proof-of-one-seam for this file.
//
// Usage:
//   import { createCheckStockToolV2 } from "./_shared/create-tool.example";
//   const tool = createCheckStockToolV2(backend, ctx);

import { z } from "zod";
import { Type } from "@google/genai";
import type { Schema } from "@google/genai";
import { createTool } from "./create-tool";
import {
  findProductInfoMatch,
  cleanupProductName,
} from "@/app/api/business-assistant/_lib/handlers/inventory-matching";
import {
  buildProductStockAnswer,
  buildInventorySummaryAnswer,
} from "@/app/api/business-assistant/_lib/handlers/inventory-responses";
import type { ProductInfoEntry } from "@/app/api/business-assistant/_lib/types";

// ── Backend port ───────────────────────────────────────────────────────────────

/** Backend-agnostic port for the stock.check_stock tool. */
export interface CheckStockBackend {
  productDirectory: ProductInfoEntry[];
  locale: string;
  business: { name: string; currency: string };
  inventorySummary: { productLines: number; totalUnits: number; totalValue: number };
}

// ── Zod input schema ───────────────────────────────────────────────────────────

const CheckStockInput = z.object({
  product_name: z.string().optional().default(""),
});

// ── Genai schema (LLM calling convention) ─────────────────────────────────────

const CHECK_STOCK_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    product_name: {
      type: Type.STRING,
      description:
        "Product name or fragment to look up. Omit to return full inventory summary.",
    },
  },
};

// ── Factory ────────────────────────────────────────────────────────────────────

export function createCheckStockToolV2(backend: CheckStockBackend) {
  return createTool({
    name: "stock.check_stock",
    description:
      "Look up the current stock level of a specific product by name, or return the full inventory summary when no product is specified.",
    // [feat/factory-trust-upgrade] — prohibitions seam proof.
    // The factory appends these as a numbered "PROHIBICIONES" block to the description.
    // The LLM sees them before forming any call — no per-tool description boilerplate needed.
    prohibitions: [
      "Never invent stock quantities — return ONLY values from the database.",
      "Do not fabricate product names that are not in the catalog.",
    ],
    schema: CHECK_STOCK_SCHEMA,
    inputSchema: CheckStockInput,
    backend,
    execute: async ({ input, backend: b }) => {
      const productName = cleanupProductName(input.product_name.trim());

      if (!productName) {
        const products = b.productDirectory.map((p) => ({
          name: p.name,
          price: p.price,
          stock: p.stock,
        }));
        return {
          answer: buildInventorySummaryAnswer(
            { business: b.business, inventorySummary: b.inventorySummary, products },
            b.locale,
          ),
        };
      }

      const { match, ambiguous } = findProductInfoMatch(productName, b.productDirectory);

      if (ambiguous) {
        return {
          answer: `Encontré varios productos parecidos a "${productName}". Decime cuál es.`,
          ambiguous: true,
        };
      }

      if (!match) {
        return { error: { code: "NOT_FOUND", message: `Producto "${productName}" no encontrado.` } };
      }

      return {
        answer: buildProductStockAnswer(match, b.locale),
        found: true,
        product: { id: match.id, name: match.name, stock: match.stock },
      };
    },
  });
}
