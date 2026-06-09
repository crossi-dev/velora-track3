import "server-only";
// customer-agent-tools-order.ts — Deterministic order/cart state for the Customer Agent.
//
// WHY: the order (quantity, total) must NEVER live only in the LLM's conversation
// memory, and the LLM must NEVER compute the money or decide stock. That is the
// custom/fragile pattern that produced "3" → "33" ($16500) and the
// "no me quedan" → "sí tengo" stock contradiction. Industry-standard agentic
// commerce 2026 = deterministic tools own the cart, catalog and pricing; the LLM
// orchestrates but reads authoritative numbers from the tool.
//   Stripe Agentic Commerce: https://stripe.com/guides/agentic-commerce
//   Shopify commerce agents:  https://shopify.dev/docs/agents
//   ADK structured state:     https://google.github.io/adk-docs/sessions/state/
//
// The cart lives in ADK session.state under the (session-scoped, no prefix) key
// "order" so it persists across the customer's turns and resets per conversation.

import { FunctionTool } from "@google/adk";
import type { Context } from "@google/adk";
import { Type } from "@google/genai";
import type { Schema } from "@google/genai";
import { prisma } from "@/lib/prisma";
import { cloudLog } from "@/lib/cloud-logger";
import type { CustomerAgentToolContext } from "./customer-agent-tools";

const ORDER_STATE_KEY = "order";

export interface OrderLine {
  productId: string;
  name: string;
  qty: number;
  unitPrice: number;
  lineTotal: number;
}
export interface OrderState {
  items: OrderLine[];
  subtotal: number;
}

const EMPTY_ORDER: OrderState = { items: [], subtotal: 0 };

/** Read the current cart from session.state (never throws — defaults to empty). */
export function readOrder(toolContext?: Context): OrderState {
  const raw = toolContext?.state.get(ORDER_STATE_KEY) as OrderState | undefined;
  return raw && Array.isArray(raw.items) ? raw : EMPTY_ORDER;
}

function writeOrder(toolContext: Context | undefined, order: OrderState): void {
  toolContext?.state.set(ORDER_STATE_KEY, order);
}

export const UPDATE_ORDER_ITEM_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    productId: {
      type: Type.STRING,
      description: "Product id from get_catalog. Required — never invent it.",
    },
    quantity: {
      type: Type.NUMBER,
      description: "Units the customer wants of this product. Use 0 to remove the line.",
    },
  },
  required: ["productId", "quantity"],
};

// ── Tool: update_order_item ─────────────────────────────────────────────────────

/**
 * Sets the quantity of a product in the customer's order. Price and stock come
 * from the DB (authoritative) — the LLM passes only productId + integer quantity
 * and reads the resulting totals back. This makes quantity, stock and totals
 * impossible for the LLM to drift or hallucinate.
 */
export function createUpdateOrderItemTool(ctx: CustomerAgentToolContext) {
  return new FunctionTool({
    name: "update_order_item",
    description:
      "Adds or sets a product line in the customer's order with an exact quantity. " +
      "Call this after get_catalog whenever the customer states how many of a product " +
      "they want. Returns the updated cart with line totals and subtotal computed from " +
      "DB prices — use those numbers; never calculate totals yourself. quantity=0 removes the line.",
    parameters: UPDATE_ORDER_ITEM_SCHEMA,
    execute: async (args: unknown, tool_context?: Context) => {
      const input = (args ?? {}) as { productId?: string; quantity?: number };
      if (!input.productId) return { error: "Falta el productId (sacalo de get_catalog)." };

      const qty = Math.trunc(Number(input.quantity));
      if (!Number.isFinite(qty) || qty < 0) return { error: "Cantidad inválida." };

      const product = await prisma.product.findFirst({
        where: { id: input.productId, businessId: ctx.businessId },
        select: { id: true, name: true, price: true, quantity: true },
      });
      if (!product) return { error: "No encontré ese producto en el catálogo." };

      if (qty > product.quantity) {
        return {
          error: `Solo hay ${product.quantity} de ${product.name} disponibles.`,
          available: product.quantity,
        };
      }

      const order = readOrder(tool_context);
      const items = order.items.filter((i) => i.productId !== product.id);
      if (qty > 0) {
        const unitPrice = Number(product.price);
        items.push({ productId: product.id, name: product.name, qty, unitPrice, lineTotal: unitPrice * qty });
      }
      const subtotal = items.reduce((s, i) => s + i.lineTotal, 0);
      const next: OrderState = { items, subtotal };
      writeOrder(tool_context, next);

      cloudLog({
        severity: "INFO", component: "CustomerAgent", action: "CUSTOMER_ORDER_ITEM_SET",
        a2a_transfer: false, message: `update_order_item: ${product.name} x${qty}`,
        data: { businessId: ctx.businessId, productId: product.id, qty, subtotal },
      });

      return { order: next };
    },
  });
}
