import "server-only";
// FunctionTool wrapper for register_sale.
//
// When the agent wants to register a sale, it calls this tool. The tool
// validates product + customer IDs against the catalog (money-path guard
// identical to handleRegisterSale in intent-handlers/sale.ts) and emits
// the structured sale action that the client uses to open the confirm modal.
//
// Does NOT duplicate the LLM path. The pure validation logic is inlined
// here because the full handleRegisterSale is tightly coupled to the
// HTTP IntentHandler signature — we extract only the data-layer concern.

import { FunctionTool } from "@google/adk";
import { Type } from "@google/genai";
import type { Schema } from "@google/genai";
import type { ProductInfoEntry } from "@/app/api/business-assistant/_lib/types";

export interface RegisterSaleToolContext {
  productDirectory: ProductInfoEntry[];
  customers: Array<{ id: string; name: string }>;
}

const REGISTER_SALE_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    product_id: {
      type: Type.STRING,
      description: "The catalog product ID to sell.",
    },
    product_name: {
      type: Type.STRING,
      description: "Human-readable product name (for confirmation message).",
    },
    customer_id: {
      type: Type.STRING,
      description: "The customer ID (optional).",
    },
    customer_name: {
      type: Type.STRING,
      description: "Human-readable customer name (for confirmation message).",
    },
    quantity: {
      type: Type.NUMBER,
      description: "Units to sell. Defaults to 1.",
    },
    auto_send: {
      type: Type.BOOLEAN,
      description: "Whether to auto-send a WhatsApp receipt after the sale.",
    },
  },
  required: ["product_id", "product_name"],
};

export function createRegisterSaleTool(ctx: RegisterSaleToolContext) {
  return new FunctionTool({
    name: "register_sale",
    description:
      "Register a sale for a product to a customer. Use this when the user says they sold something, e.g. 'vendí 2 cubiertas Firestone a Juan'. Returns a structured sale action for client confirmation.",
    parameters: REGISTER_SALE_SCHEMA,
    execute: async (args: unknown) => {
      const input = args as {
        product_id: string;
        product_name: string;
        customer_id?: string;
        customer_name?: string;
        quantity?: number;
        auto_send?: boolean;
      };

      // Money-path guard: reject IDs not in catalog.
      const productInCatalog = ctx.productDirectory.find(
        (p) => p.id === input.product_id,
      );
      if (!productInCatalog) {
        const clarification = input.product_name
          ? `No encontré "${input.product_name}" en el catálogo. ¿Cuál es el producto exacto?`
          : "No pude identificar el producto. ¿Cuál es el producto que querés vender?";
        return { error: "product_not_found", answer: clarification };
      }

      const qty = Math.max(1, Math.round(input.quantity ?? 1));
      const customerName = input.customer_name ?? "cliente";

      const itemsLabel =
        qty > 1 ? `${qty} × ${productInCatalog.name}` : productInCatalog.name;
      const confirmMessage = `Te paso a confirmar la venta de ${itemsLabel} a ${customerName}.`;

      // Include resolved productName and customerName so the synthesizer
      // (employee-agent.synthesize.ts) can emit a valid saleDraft without
      // needing access to the product directory a second time.
      const resolvedCustomerName = input.customer_id
        ? (ctx.customers.find((c) => c.id === input.customer_id)?.name ?? input.customer_name ?? null)
        : null;

      return {
        answer: confirmMessage,
        primaryAction: {
          type: "register_sale",
          matchedProductId: input.product_id,
          matchedCustomerId: input.customer_id ?? null,
          quantity: qty,
          autoSend: input.auto_send ?? false,
        },
        resolvedProductName: productInCatalog.name,
        resolvedCustomerName,
      };
    },
  });
}
