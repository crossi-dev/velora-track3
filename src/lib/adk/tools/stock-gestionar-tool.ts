import "server-only";
// stock-gestionar-tool.ts — stock.gestionar_stock FunctionTool via createTool.
//
// RESHAPE of execute-stock-load-fast-path.ts + intent-handlers/stock.ts.
// Existing load + adjust semantics preserved exactly; stocktake action added.
//
// Pattern C (intent-emitting) — NO direct DB write in this tool.
// Tool returns { intent, data, summary } so the Supervisor's downstream pipeline
// (supervisor-action-mapper.ts → owner-handler.ts) materialises via the existing
// idempotent + audited mutation path — same as gestionar_producto.
//
// Intent mapping:
//   action="load"      → intent "stock_load"    (mapStockLoad in supervisor-action-mapper)
//   action="adjust"    → intent "adjust_stock"  (mapAdjustStock)
//   action="stocktake" → reads systemQty, computes variance, emits "adjust_stock"
//                        with mode="set" and quantity=countedQty. The summary shows
//                        the system vs. physical delta so the owner can review before
//                        confirming. No DB write until owner confirms.
//
// Source: Square BatchChangeInventory (inventory mutation patterns):
//   https://developer.squareup.com/reference/square/inventory-api/batch-change-inventory

import { z } from "zod";
import { Type } from "@google/genai";
import type { Schema } from "@google/genai";
import { createTool } from "./_shared/create-tool";
import { findProductInfoMatch } from "@/app/api/business-assistant/_lib/handlers/inventory-matching";
import { createVentasBackend } from "@/lib/mcp/_lib/ventas-backend.factory";
import type { StockToolsBackend } from "./stock-tools-backend";

const GestionarStockInput = z.object({
  action: z.enum(["load", "adjust", "stocktake"], {
    errorMap: () => ({
      message: "Acción debe ser 'load' (carga), 'adjust' (ajuste), o 'stocktake' (conteo físico).",
    }),
  }),
  product_name: z.string().min(1, "El nombre del producto es requerido."),
  quantity: z
    .number()
    .int("La cantidad debe ser un número entero.")
    .describe(
      "load/adjust(increase|decrease): unidades. adjust(set): valor final. stocktake: conteo físico.",
    ),
  mode: z
    .enum(["set", "increase", "decrease"])
    .optional()
    .describe("Solo para action='adjust'."),
  unit_cost: z
    .number()
    .min(0, "El costo no puede ser negativo.")
    .optional()
    .describe("Costo unitario en pesos. Solo para action='load'."),
  idempotency_key: z
    .string()
    .min(1, "La clave de idempotencia es requerida.")
    .describe("Clave única. Formato: stock-{action}-{productName}-{timestamp}."),
});

const GESTIONAR_STOCK_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    action: {
      type: Type.STRING,
      description:
        "'load' = ingreso de mercadería. 'adjust' = corrección manual (set/increase/decrease). 'stocktake' = conteo físico.",
    },
    product_name: { type: Type.STRING, description: "Nombre del producto en el catálogo." },
    quantity: {
      type: Type.NUMBER,
      description:
        "Unidades. load/adjust(increase|decrease): cuántas. adjust(set): valor final. stocktake: lo contado.",
    },
    mode: {
      type: Type.STRING,
      description: "Solo para action='adjust'. 'set', 'increase', o 'decrease'.",
    },
    unit_cost: { type: Type.NUMBER, description: "Costo unitario en pesos. Solo para action='load'." },
    idempotency_key: {
      type: Type.STRING,
      description: "Clave única de idempotencia. Formato: stock-{action}-{productName}-{timestamp}.",
    },
  },
  required: ["action", "product_name", "quantity", "idempotency_key"],
};

export function createGestionarStockTool(backend: StockToolsBackend) {
  return createTool({
    name: "stock.gestionar_stock",
    description:
      "Gestiona el inventario. " +
      "action='load': ingreso de mercadería (propone carga de stock; dueño confirma antes de ejecutar). " +
      "action='adjust': corrección manual (set/increase/decrease; propone ajuste, dueño confirma). " +
      "action='stocktake': conteo físico — muestra diferencia sistema vs. contado, dueño confirma antes de ejecutar. " +
      "NUNCA escribe en DB directamente — todas las mutaciones se materializan después de la confirmación del dueño.",
    schema: GESTIONAR_STOCK_SCHEMA,
    inputSchema: GestionarStockInput,
    backend,
    execute: async ({ input, backend: b }) => {
      const { businessId } = b;

      const { match, ambiguous } = findProductInfoMatch(input.product_name, b.productDirectory);

      if (ambiguous) {
        return {
          error: {
            code: "AMBIGUOUS_PRODUCT",
            message: `Encontré varios productos parecidos a "${input.product_name}". Decime cuál es exactamente.`,
          },
        };
      }

      if (!match) {
        return {
          error: { code: "PRODUCT_NOT_FOUND", message: `No encontré "${input.product_name}" en el catálogo.` },
        };
      }

      // ── action="load" ──────────────────────────────────────────────────────
      // Emit stock_load intent. Data shape matches mapStockLoad in supervisor-action-mapper.ts.
      if (input.action === "load") {
        const qty = Math.abs(Math.round(input.quantity));
        if (qty === 0) {
          return { error: { code: "INVALID_QUANTITY", message: "La cantidad a cargar debe ser mayor a 0." } };
        }
        const costLabel = input.unit_cost != null ? ` a $${input.unit_cost}/u` : "";
        return {
          intent: "stock_load",
          data: {
            itemName: match.name,
            quantity: qty,
            unitPrice: input.unit_cost ?? null,
            supplierName: "",
          },
          summary: `Cargar +${qty} ${match.name}${costLabel}`,
        };
      }

      // ── action="adjust" ────────────────────────────────────────────────────
      // Emit adjust_stock intent. Data shape matches mapAdjustStock in supervisor-action-mapper.ts.
      if (input.action === "adjust") {
        if (!input.mode) {
          return { error: { code: "MISSING_MODE", message: "Necesito saber si querés 'set', 'increase' o 'decrease' el stock." } };
        }
        const quantity = input.quantity;
        if (quantity < 0) {
          return { error: { code: "INVALID_QUANTITY", message: "La cantidad no puede ser negativa." } };
        }
        const modeLabel =
          input.mode === "set" ? `a ${quantity}` :
          input.mode === "increase" ? `+${quantity}` :
          `-${quantity}`;
        return {
          intent: "adjust_stock",
          data: {
            productName: match.name,
            mode: input.mode,
            quantity,
          },
          summary: `Ajustar stock de "${match.name}" ${modeLabel}`,
        };
      }

      // ── action="stocktake" ─────────────────────────────────────────────────
      // Read systemQty to compute variance. Emit adjust_stock with mode="set" and
      // quantity=countedQty. The delta is shown in the summary so the owner sees
      // the discrepancy BEFORE confirming. No DB write happens here.
      const countedQty = Math.round(input.quantity);
      if (countedQty < 0) {
        return { error: { code: "INVALID_QUANTITY", message: "La cantidad contada no puede ser negativa." } };
      }

      const ventasBackend = createVentasBackend();
      const currentProduct = await ventasBackend.getProductStock({ tenantId: businessId, productId: match.id });

      if (!currentProduct) {
        return { error: { code: "PRODUCT_NOT_FOUND", message: "Producto no encontrado en base de datos." } };
      }

      const systemQty = currentProduct.quantity;
      const variance = countedQty - systemQty;

      if (variance === 0) {
        return {
          productId: match.id, productName: match.name, action: "stocktake",
          counted: countedQty, system: systemQty, variance: 0,
          message: `Conteo de "${match.name}": ${countedQty} contadas = sistema. Sin diferencia, no hace falta ajustar.`,
        };
      }

      const varianceLabel = variance > 0 ? `sobrante de +${variance} u.` : `faltante de ${variance} u.`;
      return {
        intent: "adjust_stock",
        data: {
          productName: match.name,
          mode: "set",
          quantity: countedQty,
        },
        summary: `Conteo físico "${match.name}": sistema ${systemQty}, contado ${countedQty} → ${varianceLabel}. Confirmar para ajustar.`,
      };
    },
  });
}
