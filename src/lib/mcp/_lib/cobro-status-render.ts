// src/lib/mcp/_lib/cobro-status-render.ts — open_cobro_status render tool + resource.
//
// Extracted from payments-tools.ts to stay under the 300-line file-size limit.
// Contains:
//   - estado → UCP line status + statusLabel mapping
//   - toCobroUCPOrder() — maps CobroDetail to a UCP Order
//   - registerCobroStatusRenderTool() — registers the resource + render tool on an McpServer
//
// Tenant isolation: businessId ALWAYS comes from the closure parameter — never from tool input.
//
// UCP Order spec: https://ucp.dev/latest/specification/order/
// NOTE: UCP Order has no buyer or created_at fields. customerName, statusLabel, estado,
// createdAt, and confirmedAt are Velora display extensions carried alongside the UCP order
// in structuredContent.prefill.order.
//
// Estado → UCP line status mapping:
//   pending   → "processing"  (awaiting payment)
//   confirmed → "fulfilled"   (payment received)
//   expired   → "removed"     (link expired, no payment)
//   cancelled → "removed"     (cancelled by operator)

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerAppTool, registerAppResource, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import type { PaymentsBackend, CobroDetail, CobroEstado } from "./payments-backend.port";
import type { UCPLineStatus, UCPOrder } from "./ucp-types";
import { COBRO_STATUS_HTML } from "../widgets/generated/cobro-status.html";

/** Canonical ui:// URI for the cobro-status widget resource. */
export const COBRO_STATUS_RESOURCE_URI = "ui://cobro-status";

// ── Estado mappings ───────────────────────────────────────────────────────────

const ESTADO_TO_UCP_LINE_STATUS: Record<CobroEstado, UCPLineStatus> = {
  pending:   "processing",
  confirmed: "fulfilled",
  expired:   "removed",
  cancelled: "removed",
};

const ESTADO_TO_STATUS_LABEL: Record<CobroEstado, string> = {
  pending:   "esperando_pago",
  confirmed: "pagado",
  expired:   "vencido",
  cancelled: "cancelado",
};

function toCobroUCPOrder(detail: CobroDetail): UCPOrder {
  const lineStatus = ESTADO_TO_UCP_LINE_STATUS[detail.estado];
  return {
    id: detail.id,
    line_items: detail.items.map((it, idx) => ({
      id: `${detail.id}:${idx}`,
      item: {
        id: it.productId ?? `${detail.id}:item:${idx}`,
        title: it.name,
        price: { amount: Math.round(it.unitPrice * 100), currency: "ARS" },
      },
      quantity: it.quantity,
      status: lineStatus,
    })),
    totals: [{ type: "total" as const, amount: Math.round(detail.totalARS * 100) }],
    currency: "ARS",
    ...(detail.checkoutUrl ? { permalink_url: detail.checkoutUrl } : {}),
  };
}

// ── Registration ──────────────────────────────────────────────────────────────

/**
 * Registers the ui://cobro-status resource and the open_cobro_status render
 * tool on the given server.
 *
 * Side-effect-free (READ-ONLY). businessId comes from the closure — never from
 * tool input (tenant isolation).
 */
export function registerCobroStatusRenderTool(
  server: McpServer,
  businessId: string,
  backend: PaymentsBackend,
): void {
  // Resource: self-contained HTML widget (bundled by build-widget.mjs).
  registerAppResource(
    server,
    "Estado del cobro",
    COBRO_STATUS_RESOURCE_URI,
    // _meta.ui.csp: sandbox CSP ChatGPT requires to render. Self-contained → no external origins.
    { _meta: { ui: { csp: { connectDomains: [], resourceDomains: [], frameDomains: [] } } } },
    (uri) => ({
      contents: [{ uri: uri.href, mimeType: RESOURCE_MIME_TYPE, text: COBRO_STATUS_HTML }],
    }),
  );

  // Render tool: fetch one cobro, map to UCP Order, pre-fill widget.
  registerAppTool(
    server,
    "open_cobro_status",
    {
      title: "Open cobro status",
      description:
        "Use this when the owner asks to see the status of a cobro visually. For raw JSON status without a widget, use `get_payment_intent_status` instead. " +
        "Opens the cobro status widget — a read-only view of ONE PaymentIntent showing its " +
        "current payment state (esperando pago, pagado, vencido, cancelado), the customer name, " +
        "line items, total (ARS), and dates. Accepts paymentIntentId OR customerName " +
        "(the most recent PI for that customer is used). At least one must be provided. " +
        "Data is mapped to UCP Order shape (ucp.dev/latest/specification/order/). " +
        "Side-effect-free — READ-ONLY, no mutation. " +
        "Returns a prefill with order: null when the cobro is not found.",
      // openai/outputTemplate = ChatGPT's primary render key; ui.resourceUri = MCP-Apps standard. Same ui:// target.
      _meta: { ui: { resourceUri: COBRO_STATUS_RESOURCE_URI }, "openai/outputTemplate": COBRO_STATUS_RESOURCE_URI },
      // outputSchema: ChatGPT renders the widget only when the tool declares it (OpenAI quickstart).
      outputSchema: { prefill: z.object({}).passthrough() },
      inputSchema: {
        paymentIntentId: z
          .string()
          .optional()
          .describe(
            "Velora PaymentIntent id. Optional when customerName is provided.",
          ),
        customerName: z
          .string()
          .optional()
          .describe(
            "Customer name (fuzzy match). Resolves the most recent PaymentIntent for this " +
            "customer in the business. Optional when paymentIntentId is provided.",
          ),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (args) => {
      // Validate: at least one lookup key required.
      if (!args.paymentIntentId && !args.customerName) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: "missing_lookup_key",
                message: "Provide paymentIntentId or customerName.",
              }),
            },
          ],
          isError: true,
        };
      }

      try {
        const detail = await backend.getCobroDetail({
          tenantId: businessId,
          paymentIntentId: args.paymentIntentId,
          customerName: args.customerName,
        });

        if (!detail) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ order: null, message: "No encontré ese cobro." }),
              },
            ],
            structuredContent: { prefill: { order: null, createdAt: Date.now() } },
          };
        }

        const ucp = toCobroUCPOrder(detail);
        const statusLabel = ESTADO_TO_STATUS_LABEL[detail.estado];

        const prefillOrder = {
          ucp,
          customerName: detail.customerName,
          statusLabel,
          estado: detail.estado,
          createdAt: detail.createdAt.toISOString(),
          confirmedAt: detail.confirmedAt ? detail.confirmedAt.toISOString() : null,
        };

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ order: prefillOrder }),
            },
          ],
          // Election key for widget instance supersession (claude.com/docs/connectors/
          // building/mcp-apps/instance-supersession) — top-level, sibling to `order`,
          // distinct from order.createdAt (the cobro's own creation date).
          structuredContent: { prefill: { order: prefillOrder, createdAt: Date.now() } },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ code: "COBRO_STATUS_ERROR", message }) }],
          isError: true,
        };
      }
    },
  );
}
