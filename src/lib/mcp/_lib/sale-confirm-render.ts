// src/lib/mcp/_lib/sale-confirm-render.ts — open_sale_confirm render tool + resource.
//
// Extracted as a standalone file to stay under the 300-line file-size limit.
// Contains:
//   - registerSaleConfirmRenderTool() — registers the resource + render tool on an McpServer
//
// Tenant isolation: businessId ALWAYS comes from the closure parameter — never from tool input.
//
// Pattern: preview→confirm (same safe money pattern as payment-link-wizard).
// The widget shows the resolved line items, customer, and total — then fires register_sale
// via callServerTool. register_sale owns all idempotency, audit, and inventory guards.
//
// Guard: fails fast if any productId is not found in the catalog (never silent price-0).
// No-customer path: customerId is optional — register_sale allows consumidor final.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerAppTool, registerAppResource, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { prisma } from "@/lib/prisma";
import { SALE_CONFIRM_HTML } from "../widgets/generated/sale-confirm.html";
import { nextSeq } from "./election-seq";

/** Canonical ui:// URI for the sale-confirm widget resource. */
export const SALE_CONFIRM_RESOURCE_URI = "ui://sale-confirm";

// ── Types ─────────────────────────────────────────────────────────────────────

interface ResolvedItem {
  productId: string;
  quantity: number;
  name: string;
  unitPrice: number;
}

// ── Prefill resolution ────────────────────────────────────────────────────────

/** Resolves product names + catalog prices and optional customer name/phone.
 *  Returns { items, customerName, customerPhone, totalARS } or throws with a structured error. */
async function resolveSaleConfirmPrefill(
  businessId: string,
  items: Array<{ productId: string; quantity: number }>,
  customerId?: string,
): Promise<
  | { items: ResolvedItem[]; customerName: string; customerPhone: string | null; totalARS: number }
  | { domainError: string; errorMessage: string }
> {
  const productIds = items.map((i) => i.productId);
  const hasCustomer = Boolean(customerId && customerId.trim() !== "");

  const [products, customer] = await Promise.all([
    prisma.product.findMany({
      where: { id: { in: productIds }, businessId },
      select: { id: true, name: true, price: true },
    }),
    hasCustomer
      ? prisma.customer.findFirst({
          where: { id: customerId!, businessId },
          select: { name: true, phone: true },
        })
      : Promise.resolve(null),
  ]);

  if (hasCustomer && !customer) {
    return {
      domainError: "customer_not_found",
      errorMessage:
        "No encontré ese cliente en tu negocio. Verificá el cliente antes de confirmar la venta.",
    };
  }

  const byId = new Map(products.map((p) => [p.id, p]));

  // Guard: fail fast if any productId is missing from the catalog.
  for (const item of items) {
    if (!byId.has(item.productId)) {
      return {
        domainError: "product_not_found",
        errorMessage: `No encontré el producto ${item.productId} en tu catálogo. Resolvé los productos con query_catalog antes de confirmar la venta.`,
      };
    }
  }

  const resolvedItems: ResolvedItem[] = items.map((i) => {
    const p = byId.get(i.productId)!;
    return {
      productId: i.productId,
      quantity: i.quantity,
      name: p.name,
      unitPrice: Number(p.price),
    };
  });

  const totalARS = resolvedItems.reduce((s, it) => s + it.quantity * it.unitPrice, 0);

  return {
    items: resolvedItems,
    customerName: hasCustomer ? customer!.name : "Consumidor final",
    customerPhone: hasCustomer ? customer!.phone : null,
    totalARS,
  };
}

// ── Registration ──────────────────────────────────────────────────────────────

/**
 * Registers the ui://sale-confirm resource and the open_sale_confirm render
 * tool on the given server.
 *
 * Preview-then-confirm: renders resolved line items + total before any mutation.
 * The mutation itself (register_sale) fires from the widget via callServerTool
 * — register_sale owns all idempotency, audit, and inventory guards.
 *
 * businessId comes from the closure — never from tool input (tenant isolation).
 */
export function registerSaleConfirmRenderTool(
  server: McpServer,
  businessId: string,
): void {
  // Resource: self-contained HTML widget (bundled by build-widget.mjs).
  registerAppResource(
    server,
    "Confirmar venta",
    SALE_CONFIRM_RESOURCE_URI,
    { _meta: { ui: { csp: { connectDomains: [], resourceDomains: [], frameDomains: [] } } } },
    (uri) => ({
      contents: [{ uri: uri.href, mimeType: RESOURCE_MIME_TYPE, text: SALE_CONFIRM_HTML }],
    }),
  );

  // Render tool: resolve catalog prices, pre-fill widget with preview.
  registerAppTool(
    server,
    "open_sale_confirm",
    {
      title: "Open sale confirmation",
      description:
        "Use this when the owner wants to preview a cash sale before recording it. " +
        "Opens a VISUAL preview of the sale — resolved product names, unit prices, quantities, " +
        "and total — with a confirm button that fires register_sale. " +
        "For immediate non-visual sale recording, use `register_sale` directly. " +
        "Resolves catalog prices server-side (never silent price-0). " +
        "customerId is OPTIONAL — omit for anonymous (consumidor final) sales. " +
        "Returns isError when any productId is not found in the catalog.",
      _meta: {
        ui: { resourceUri: SALE_CONFIRM_RESOURCE_URI },
        "openai/outputTemplate": SALE_CONFIRM_RESOURCE_URI,
      },
      outputSchema: { prefill: z.object({}).passthrough() },
      inputSchema: {
        items: z
          .array(
            z.object({
              productId: z.string().min(1).describe("Product ID (must belong to this business)."),
              quantity: z.number().int().positive().describe("Units to sell (positive integer)."),
            }),
          )
          .min(1)
          .max(500)
          .describe("Line items for the sale. At least one required."),
        customerId: z
          .string()
          .optional()
          .describe(
            "Optional customer ID. Must belong to this business. Omit for anonymous (consumidor final) sales.",
          ),
        customerName: z
          .string()
          .optional()
          .describe(
            "Optional customer display name hint. Used only when customerId is absent to show a label. " +
            "Not passed to register_sale — customerId is authoritative.",
          ),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (args) => {
      try {
        const result = await resolveSaleConfirmPrefill(businessId, args.items, args.customerId);

        if ("domainError" in result) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ error: result.domainError, message: result.errorMessage }),
              },
            ],
            isError: true,
          };
        }

        const prefill = {
          items: result.items,
          customerId: args.customerId ?? "",
          customerName: result.customerName,
          customerPhone: result.customerPhone,
          totalARS: result.totalARS,
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(prefill) }],
          // createdAt is the instance-supersession election key (Velora display
          // extension, not a business date) — same convention as
          // cobro-status-render.ts / delivery-receipt-render.ts. seq tie-breaks ties.
          structuredContent: { prefill: { ...prefill, createdAt: Date.now(), seq: nextSeq() } },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ code: "SALE_CONFIRM_ERROR", message }) }],
          isError: true,
        };
      }
    },
  );
}
