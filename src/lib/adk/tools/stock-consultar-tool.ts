import "server-only";
// stock-consultar-tool.ts — stock.consultar_stock FunctionTool via createTool.
//
// FIX: today stock_summary returns the full catalog with no filtering.
// Product.reorderThreshold exists in schema (default 5) but is unused on
// the read path. filter="low_stock" queries DB via VentasBackend port (in-process).
//
// Source: Square BatchChangeInventory (inventory filter patterns):
//   https://developer.squareup.com/reference/square/inventory-api/batch-change-inventory

import { z } from "zod";
import { Type } from "@google/genai";
import type { Schema } from "@google/genai";
import { createTool } from "./_shared/create-tool";
import { createVentasBackend } from "@/lib/mcp/_lib/ventas-backend.factory";
import { findProductInfoMatch } from "@/app/api/business-assistant/_lib/handlers/inventory-matching";
import {
  buildProductStockAnswer,
  buildInventorySummaryAnswer,
} from "@/app/api/business-assistant/_lib/handlers/inventory-responses";
import type { StockToolsBackend } from "./stock-tools-backend";

const ConsultarStockInput = z.object({
  filter: z
    .enum(["all", "low_stock", "single"])
    .default("all")
    .describe(
      "all = resumen completo; low_stock = por debajo del punto de reorden; single = un producto específico.",
    ),
  product_name: z
    .string()
    .optional()
    .describe("Nombre del producto. Requerido cuando filter='single'."),
});

const CONSULTAR_STOCK_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    filter: {
      type: Type.STRING,
      description:
        "Modo de consulta: 'all' para el resumen completo, 'low_stock' para los que están por debajo del punto de reorden, 'single' para un producto específico.",
    },
    product_name: {
      type: Type.STRING,
      description:
        "Nombre o fragmento del producto. Obligatorio solo cuando filter='single'.",
    },
  },
};

export function createConsultarStockTool(backend: StockToolsBackend) {
  return createTool({
    name: "stock.consultar_stock",
    description:
      "Consulta el stock del catálogo. " +
      "filter='all': resumen con totales. " +
      "filter='low_stock': solo los productos con stock por debajo del punto de reorden. " +
      "filter='single': busca un producto específico por nombre. " +
      "Usá este tool para '¿cuánto stock tengo de X?', '¿qué se está acabando?' o '¿cuánto inventario tengo?'.",
    schema: CONSULTAR_STOCK_SCHEMA,
    inputSchema: ConsultarStockInput,
    backend,
    execute: async ({ input, backend: b }) => {
      if (input.filter === "single") {
        if (!input.product_name) {
          return {
            error: { code: "MISSING_PRODUCT_NAME", message: "Necesito el nombre del producto." },
          };
        }

        const { match, ambiguous } = findProductInfoMatch(input.product_name, b.productDirectory);

        if (ambiguous) {
          return {
            answer: `Encontré varios productos parecidos a "${input.product_name}". Decime cuál es.`,
            ambiguous: true,
          };
        }

        if (!match) {
          return {
            error: { code: "NOT_FOUND", message: `Producto "${input.product_name}" no encontrado.` },
          };
        }

        return {
          answer: buildProductStockAnswer(match, b.locale),
          found: true,
          product: { id: match.id, name: match.name, stock: match.stock },
        };
      }

      if (input.filter === "low_stock") {
        // DB query delegated to VentasBackend port (in-process).
        // in-memory snapshot does not carry reorderThreshold.
        const ventasBackend = createVentasBackend();
        const lowStock = await ventasBackend.getLowStockProducts({ tenantId: b.businessId });

        if (lowStock.length === 0) {
          return {
            answer: "Todos los productos tienen stock por encima del punto de reorden.",
            low_stock_count: 0,
            items: [],
          };
        }

        const lines = lowStock.map(
          (p) => `· ${p.name}: ${p.stock} u. (reorden: ${p.reorderThreshold})`,
        );

        return {
          answer: `${lowStock.length} productos con stock bajo:\n${lines.join("\n")}`,
          low_stock_count: lowStock.length,
          items: lowStock.map((p) => ({
            id: p.id,
            name: p.name,
            stock: p.stock,
            reorder_threshold: p.reorderThreshold,
          })),
        };
      }

      // filter === "all" — full inventory summary
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
    },
  });
}
