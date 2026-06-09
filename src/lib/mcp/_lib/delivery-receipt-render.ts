// src/lib/mcp/_lib/delivery-receipt-render.ts — open_delivery_receipt render tool + resource.
//
// Extracted to its own file to stay under the 300-line budget.
// This is step 5 of the Velora commerce flow: after a cobro is paid, the owner
// can view the comprobante/factura + envío status for the completed order.
//
// READ-ONLY — side-effect-free. businessId ALWAYS from closure, never from tool input.
//
// UCP Order spec: https://ucp.dev/latest/specification/order/ (HTTP 200 verified 2026-06-07)
// UCP fulfillment.events[] used when a shipment row exists (carrier, tracking_number,
// occurred_at, type, description). UCP has no Invoice/comprobante concept — comprobante
// is a Velora display extension in structuredContent.prefill.order.
//
// comprobante kind logic (AFIP-flexible — verified against Invoice schema):
//   kind="factura"     — Invoice row exists AND Invoice.caeCode is a non-empty string.
//   kind="comprobante" — all other cases (no Invoice row, or no CAE).
//
// envio is null when no AndreaniShipment or OcaShipment row exists for the sale.
// Widget renders "Retiro en local — sin envío" in that case.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerAppTool, registerAppResource, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import type { PaymentsBackend, DeliveryReceipt, DeliveryEnvio } from "./payments-backend.port";
import type { UCPFulfillment, UCPOrder } from "./ucp-types";
import { DELIVERY_RECEIPT_HTML } from "../widgets/generated/delivery-receipt.html";

/** Canonical ui:// URI for the delivery-receipt widget resource. */
export const DELIVERY_RECEIPT_RESOURCE_URI = "ui://delivery-receipt";

// ── Mapping ───────────────────────────────────────────────────────────────────

function buildUCPFulfillment(envio: DeliveryEnvio | null, saleId: string): UCPFulfillment {
  if (!envio || !envio.tracking) {
    return { expectations: [], events: [] };
  }
  return {
    expectations: [],
    events: [
      {
        id: `${saleId}:shipment:0`,
        occurred_at: new Date().toISOString(), // shipment creation time not stored on the model; use now as conservative fallback
        type: "shipment",
        tracking_number: envio.tracking,
        carrier: envio.carrier,
        description: `Envío ${envio.carrier} — ${envio.status}`,
      },
    ],
  };
}

function toDeliveryUCPOrder(receipt: DeliveryReceipt): UCPOrder {
  return {
    id: receipt.saleId,
    line_items: receipt.items.map((it, idx) => ({
      id: `${receipt.saleId}:${idx}`,
      item: {
        id: it.productId ?? `${receipt.saleId}:item:${idx}`,
        title: it.name,
        price: { amount: Math.round(it.unitPrice * 100), currency: "ARS" },
      },
      quantity: it.quantity,
      status: "fulfilled" as const,
    })),
    totals: [{ type: "total" as const, amount: Math.round(receipt.totalARS * 100) }],
    currency: "ARS",
    fulfillment: buildUCPFulfillment(receipt.envio, receipt.saleId),
  };
}

// ── Registration ──────────────────────────────────────────────────────────────

/**
 * Registers the ui://delivery-receipt resource and the open_delivery_receipt render tool.
 *
 * Side-effect-free (READ-ONLY). businessId from closure — never from tool input.
 */
export function registerDeliveryReceiptRenderTool(
  server: McpServer,
  businessId: string,
  backend: PaymentsBackend,
): void {
  // Resource: self-contained HTML widget (bundled by build-widget.mjs).
  registerAppResource(
    server,
    "Comprobante y envío",
    DELIVERY_RECEIPT_RESOURCE_URI,
    // _meta.ui.csp: sandbox CSP ChatGPT requires to render. Self-contained → no external origins.
    { _meta: { ui: { csp: { connectDomains: [], resourceDomains: [], frameDomains: [] } } } },
    (uri) => ({
      contents: [{ uri: uri.href, mimeType: RESOURCE_MIME_TYPE, text: DELIVERY_RECEIPT_HTML }],
    }),
  );

  // Render tool: fetch comprobante + envío, map to UCP Order, pre-fill widget.
  registerAppTool(
    server,
    "open_delivery_receipt",
    {
      title: "Open delivery receipt",
      description:
        "Use this AFTER a cobro is paid/confirmed to view the receipt and shipping. For a cobro still awaiting payment, use `open_cobro_status` instead. " +
        "Opens the comprobante + envío widget — a read-only view of the delivery receipt " +
        "for a completed cobro. Shows the comprobante/factura (AFIP-flexible: 'Factura B' when " +
        "a real CAE exists, otherwise 'Comprobante de venta'), the line items + total (ARS), " +
        "and the envío status (carrier, tracking, status chip — or 'Retiro en local' when no " +
        "shipment was created). Accepts paymentIntentId, saleId, OR customerName (at least one). " +
        "Data is mapped to UCP Order shape (ucp.dev/latest/specification/order/) with fulfillment " +
        "populated from envío data when available. Comprobante is a Velora display extension. " +
        "Side-effect-free — READ-ONLY, no mutation. " +
        "Returns prefill.order=null when the cobro or sale is not found.",
      // openai/outputTemplate = ChatGPT's primary render key; ui.resourceUri = MCP-Apps standard. Same ui:// target.
      _meta: { ui: { resourceUri: DELIVERY_RECEIPT_RESOURCE_URI }, "openai/outputTemplate": DELIVERY_RECEIPT_RESOURCE_URI },
      // outputSchema: ChatGPT renders the widget only when the tool declares it (OpenAI quickstart).
      outputSchema: { prefill: z.object({}).passthrough() },
      inputSchema: {
        paymentIntentId: z
          .string()
          .optional()
          .describe("Velora PaymentIntent id. Optional when saleId or customerName is provided."),
        saleId: z
          .string()
          .optional()
          .describe("Velora Sale id. Optional when paymentIntentId or customerName is provided."),
        customerName: z
          .string()
          .optional()
          .describe(
            "Customer name (fuzzy match). Resolves the most recent confirmed cobro for this " +
            "customer. Optional when paymentIntentId or saleId is provided.",
          ),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (args) => {
      // Validate: at least one lookup key required.
      if (!args.paymentIntentId && !args.saleId && !args.customerName) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: "missing_lookup_key",
                message: "Provide paymentIntentId, saleId, or customerName.",
              }),
            },
          ],
          isError: true,
        };
      }

      try {
        const receipt = await backend.getDeliveryReceipt({
          tenantId: businessId,
          paymentIntentId: args.paymentIntentId,
          saleId: args.saleId,
          customerName: args.customerName,
        });

        if (!receipt) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ order: null, message: "No encontré ese comprobante." }),
              },
            ],
            structuredContent: { prefill: { order: null } },
          };
        }

        const ucp = toDeliveryUCPOrder(receipt);

        const prefillOrder = {
          ucp,
          customerName: receipt.customerName,
          customerPhone: receipt.customerPhone,
          comprobante: receipt.comprobante,
          envio: receipt.envio,
          estado: "confirmed" as const,
        };

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ order: prefillOrder }),
            },
          ],
          structuredContent: { prefill: { order: prefillOrder } },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ code: "DELIVERY_RECEIPT_ERROR", message }) }],
          isError: true,
        };
      }
    },
  );
}
