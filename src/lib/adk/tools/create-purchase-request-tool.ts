import "server-only";
// FunctionTool wrapper for create_purchase_request.
//
// Mirrors handleCreatePurchaseRequest from intent-handlers/purchase-request.ts.
// Validates itemName + quantity and emits the structured action. The actual
// record is created client-side after the user confirms the modal.

import { FunctionTool } from "@google/adk";
import { Type } from "@google/genai";
import type { Schema } from "@google/genai";

const CREATE_PURCHASE_REQUEST_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    item_name: {
      type: Type.STRING,
      description: "Name of the item or product to order.",
    },
    quantity: {
      type: Type.NUMBER,
      description: "Number of units to order.",
    },
    unit_price: {
      type: Type.NUMBER,
      description: "Unit price agreed with the supplier (optional).",
    },
    supplier_name: {
      type: Type.STRING,
      description: "Name of the supplier (optional).",
    },
  },
  required: ["item_name", "quantity"],
};

export function createPurchaseRequestTool() {
  return new FunctionTool({
    name: "create_purchase_request",
    description:
      "Create a purchase order request for restocking inventory. Use when the user wants to order from a supplier, e.g. 'pedir 50 kilos de harina a La Molinera'. Returns a confirmation action for the client modal.",
    parameters: CREATE_PURCHASE_REQUEST_SCHEMA,
    execute: async (args: unknown) => {
      const input = args as {
        item_name: string;
        quantity: number;
        unit_price?: number;
        supplier_name?: string;
      };

      const itemName = (input.item_name ?? "").trim();
      if (!itemName) {
        return {
          error: "missing_item",
          answer: "¿Qué ítem querés pedir? Ej: 50 kilos de harina.",
        };
      }

      const quantity = Math.round(input.quantity ?? 0);
      if (!quantity || quantity <= 0) {
        return {
          error: "missing_quantity",
          answer: "¿Cuántas unidades necesitás de ese ítem?",
        };
      }

      const unitPrice = input.unit_price && input.unit_price > 0 ? input.unit_price : null;
      const supplierName = (input.supplier_name ?? "").trim();

      const priceLabel = unitPrice ? ` a $${unitPrice}` : "";
      const supplierLabel = supplierName ? ` a ${supplierName}` : "";
      const confirmText = `Te paso a confirmar el pedido de ${quantity} × ${itemName}${priceLabel}${supplierLabel}.`;

      return {
        answer: confirmText,
        confirmationRequest: {
          severity: "warning",
          title: "Confirmar pedido de compra",
          message: `¿Armamos un pedido de ${quantity} × ${itemName}${priceLabel}${supplierLabel}?`,
          action: {
            type: "create_purchase_request",
            supplierName: supplierName || null,
            itemName,
            quantity,
            unitPrice,
          },
        },
      };
    },
  });
}
