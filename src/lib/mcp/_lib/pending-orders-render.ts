// src/lib/mcp/_lib/pending-orders-render.ts — open_pending_orders render tool + resource.
//
// Extracted from payments-tools.ts to stay under the 300-line file-size limit.
// Contains:
//   - UCP Order mapping types + toUCPOrder() function
//   - registerPendingOrdersRenderTool() — registers the resource + render tool on an McpServer
//
// Tenant isolation: businessId ALWAYS comes from the closure parameter — never from tool input.
//
// UCP Order spec: https://ucp.dev/latest/specification/order/
// NOTE: UCP Order has no buyer or created_at fields. customerName and createdAt are
// Velora display extensions carried alongside the UCP order in structuredContent.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerAppTool, registerAppResource, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import type { PaymentsBackend, PendingOrder } from "./payments-backend.port";
import type { UCPOrder } from "./ucp-types";
import { PENDING_ORDERS_HTML } from "../widgets/generated/pending-orders.html";
import { nextSeq } from "./election-seq";

/** Canonical ui:// URI for the pending-orders dashboard widget resource. */
export const PENDING_ORDERS_RESOURCE_URI = "ui://pending-orders";

function toUCPOrder(po: PendingOrder): UCPOrder {
  return {
    id: po.id,
    line_items: po.items.map((it, idx) => ({
      id: `${po.id}:${idx}`,
      item: {
        id: it.productId ?? `${po.id}:item:${idx}`,
        title: it.name,
        price: { amount: Math.round(it.unitPrice * 100), currency: "ARS" },
      },
      quantity: it.quantity,
      status: "processing" as const,
    })),
    totals: [{ type: "total" as const, amount: Math.round(po.totalARS * 100) }],
    currency: "ARS",
    ...(po.checkoutUrl ? { permalink_url: po.checkoutUrl } : {}),
  };
}

// ── Registration ──────────────────────────────────────────────────────────────

/**
 * Registers the ui://pending-orders resource and the open_pending_orders render
 * tool on the given server.
 *
 * Side-effect-free (READ-ONLY). businessId comes from the closure — never from
 * tool input (tenant isolation).
 */
export function registerPendingOrdersRenderTool(
  server: McpServer,
  businessId: string,
  backend: PaymentsBackend,
): void {
  // Resource: self-contained HTML widget (bundled by build-widget.mjs).
  registerAppResource(
    server,
    "Pedidos pendientes",
    PENDING_ORDERS_RESOURCE_URI,
    // _meta.ui.csp: official MCP Apps sandbox CSP field. Self-contained → no external origins.
    { _meta: { ui: { csp: { connectDomains: [], resourceDomains: [], frameDomains: [] } } } },
    (uri) => ({
      contents: [{ uri: uri.href, mimeType: RESOURCE_MIME_TYPE, text: PENDING_ORDERS_HTML }],
    }),
  );

  // Render tool: fetch pending PIs, map to UCP Order, pre-fill widget.
  registerAppTool(
    server,
    "open_pending_orders",
    {
      title: "Open pending orders",
      description:
        "Opens the pending cobros dashboard — a read-only widget listing PaymentIntents that " +
        "are awaiting payment (estado=pending). Each card shows the customer name, items summary, " +
        "total (ARS), status chip, and date. Side-effect-free — no sale, no charge. " +
        "Data is mapped to UCP Order shape (ucp.dev/latest/specification/order/). " +
        "Use this to give the owner a live view of what is still unpaid.",
      // openai/outputTemplate = ChatGPT's primary render key; ui.resourceUri = MCP-Apps standard. Same ui:// target.
      _meta: { ui: { resourceUri: PENDING_ORDERS_RESOURCE_URI }, "openai/outputTemplate": PENDING_ORDERS_RESOURCE_URI },
      // outputSchema: ChatGPT renders the widget only when the tool declares it (OpenAI quickstart).
      outputSchema: { prefill: z.object({}).passthrough() },
      inputSchema: {},
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    },
    async () => {
      try {
        const raw = await backend.listPendingOrders({ tenantId: businessId });
        const orders = raw.map((po) => ({
          ucp: toUCPOrder(po),
          customerName: po.customerName,
          createdAt: po.createdAt.toISOString(),
          status: po.status,
        }));
        // createdAt: election key for widget instance supersession (claude.com/docs/
        // connectors/building/mcp-apps/instance-supersession) — top-level, sibling to
        // `orders`, distinct from each order's own createdAt (its creation date).
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ orders, total: orders.length }) }],
          structuredContent: { prefill: { orders, createdAt: Date.now(), seq: nextSeq() } },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ code: "PENDING_ORDERS_ERROR", message }) }],
          isError: true,
        };
      }
    },
  );
}
