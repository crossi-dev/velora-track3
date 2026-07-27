// src/lib/mcp/_lib/shipment-prep-render.ts — open_shipment_prep render tool + resource.
//
// Combines catalog stock/weight data and a live shipping quote into ONE widget.
//
// Why one new tool instead of showing two widgets side by side: the MCP Apps
// spec (SEP-1865, modelcontextprotocol/ext-apps) maps exactly one interactive
// UI widget to one tool call — there is no supported way to render two
// separately-registered tools' widgets on the same screen. This tool's single
// handler pulls from BOTH the catalog backend (VentasBackend.queryCatalog —
// same read query_catalog/open_catalog_selector use) and the logistics
// backend (LogisticaBackend.resolveActiveCouriers, via the shared
// quoteShippingOptions fan-out also used by quote_shipping) and renders ONE
// widget showing both.
//
// READ-ONLY — side-effect-free. businessId ALWAYS from closure, never from
// tool input. No mutation, no shipment created, no charge — matches the
// pattern of the other `open_*` widget tools (catalog-selector, delivery-receipt).
//
// Weight computation mirrors get_package_profile's documented convention
// (logistica-helpers.ts registerPackageProfileTool): Product.weightGrams when
// available, else a 500 g/item fallback; hasRealWeightData is true only when
// ALL items had real weight data. It is computed here directly from the
// catalog rows (not via get_package_profile) because that tool assumes qty=1
// per productId — this tool needs exact per-item quantities from `items`.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerAppTool, registerAppResource, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import type { VentasBackend } from "./ventas-backend.port";
import type { LogisticaBackend } from "./logistica-backend.port";
import { quoteShippingOptions } from "./logistica-helpers";
import { errResponse } from "./mcp-responses";
import { SHIPMENT_PREP_HTML } from "../widgets/generated/shipment-prep.html";

/** Canonical ui:// URI for the shipment-prep widget resource. */
export const SHIPMENT_PREP_RESOURCE_URI = "ui://shipment-prep";

/** Default weight (grams) for a product with no weightGrams on file — mirrors get_package_profile. */
const DEFAULT_ITEM_WEIGHT_GRAMS = 500;

// ── Prefill shape (matches shipment-prep.tsx's Prefill contract) ─────────────

interface ShipmentItemPrefill {
  productId: string;
  quantity: number;
  found: boolean;
  name: string | null;
  unitPrice: number | null;
  stock: number | null;
  sufficientStock: boolean;
  weightGrams: number;
}

// ── Registration ──────────────────────────────────────────────────────────────

/**
 * Registers the ui://shipment-prep resource and the open_shipment_prep render tool.
 *
 * Side-effect-free (READ-ONLY). businessId from closure — never from tool input.
 * Requires both the ventas and logistica backends — registered by server.ts only
 * when both the "ventas" and "logistica" packs are wanted.
 */
export function registerShipmentPrepRenderTool(
  server: McpServer,
  businessId: string,
  ventasBackend: VentasBackend,
  logisticaBackend: LogisticaBackend,
): void {
  // Resource: self-contained HTML widget (bundled by build-widget.mjs).
  registerAppResource(
    server,
    "Preparar envío",
    SHIPMENT_PREP_RESOURCE_URI,
    // _meta.ui.csp: official MCP Apps sandbox CSP field. Self-contained → no external origins.
    { _meta: { ui: { prefersBorder: false, csp: { connectDomains: [], resourceDomains: [], frameDomains: [] } } } },
    (uri) => ({
      contents: [{ uri: uri.href, mimeType: RESOURCE_MIME_TYPE, text: SHIPMENT_PREP_HTML }],
    }),
  );

  registerAppTool(
    server,
    "open_shipment_prep",
    {
      title: "Open shipment prep",
      description:
        "Use this when the owner wants to see stock and a shipping quote for a set of products " +
        "TOGETHER on one screen — before creating the actual shipment. " +
        "Opens the shipment-prep widget: for each product+quantity in `items`, shows whether it " +
        "was found, its price, and whether stock covers the requested quantity; computes the total " +
        "package weight (Product.weightGrams per item, falling back to 500 g/item when missing); " +
        "and quotes shipping from every active courier for the business between originPostalCode " +
        "and destinationPostalCode (same fan-out as quote_shipping), sorted by price ascending. " +
        "Side-effect-free — no shipment is created, no stock or money is touched. " +
        "`items` uses the same shape as open_catalog_selector's confirmed selection " +
        "(productId + quantity). Call quote_shipping directly if you only need the shipping " +
        "quote without stock info, or query_catalog if you only need stock without a quote.",
      // openai/outputTemplate = ChatGPT's primary render key; ui.resourceUri = MCP-Apps standard. Same ui:// target.
      _meta: { ui: { resourceUri: SHIPMENT_PREP_RESOURCE_URI }, "openai/outputTemplate": SHIPMENT_PREP_RESOURCE_URI },
      // outputSchema: ChatGPT renders the widget only when the tool declares it (OpenAI quickstart).
      outputSchema: { prefill: z.object({}).passthrough() },
      inputSchema: {
        items: z
          .array(
            z.object({
              productId: z.string().min(1).describe("Product ID (must belong to this business)."),
              quantity: z.number().int().positive().describe("Units to ship for this product."),
            }),
          )
          .min(1)
          .describe("Products and quantities to ship — same shape as open_catalog_selector's confirmed selection."),
        originPostalCode: z
          .string()
          .describe("Origin postal code (4 digits, no letters) — the business's own postal code."),
        destinationPostalCode: z
          .string()
          .describe("Destination postal code (4 digits, no letters) — the customer's address."),
        declaredValue: z
          .number()
          .nonnegative()
          .optional()
          .describe("Declared value in ARS for insurance. Defaults to 0 when omitted."),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        // ── 1. Catalog backend: resolve stock + weight for each requested item ──
        const catalogProducts = await ventasBackend.queryCatalog({ tenantId: businessId });
        const byId = new Map(catalogProducts.map((p) => [p.id, p]));

        let totalWeightGrams = 0;
        let hasRealWeightData = true;
        const items: ShipmentItemPrefill[] = args.items.map((requested) => {
          const product = byId.get(requested.productId);
          if (!product) {
            hasRealWeightData = false;
            totalWeightGrams += DEFAULT_ITEM_WEIGHT_GRAMS * requested.quantity;
            return {
              productId: requested.productId,
              quantity: requested.quantity,
              found: false,
              name: null,
              unitPrice: null,
              stock: null,
              sufficientStock: false,
              weightGrams: DEFAULT_ITEM_WEIGHT_GRAMS,
            };
          }
          const unitWeightGrams = product.weightGrams ?? DEFAULT_ITEM_WEIGHT_GRAMS;
          if (product.weightGrams == null) hasRealWeightData = false;
          totalWeightGrams += unitWeightGrams * requested.quantity;
          return {
            productId: requested.productId,
            quantity: requested.quantity,
            found: true,
            name: product.name,
            unitPrice: product.price,
            stock: product.stock,
            sufficientStock: product.stock >= requested.quantity,
            weightGrams: unitWeightGrams,
          };
        });

        // ── 2. Logistics backend: quote shipping for the computed weight ────────
        const quote = await quoteShippingOptions(logisticaBackend, businessId, {
          originPostalCode: args.originPostalCode,
          destinationPostalCode: args.destinationPostalCode,
          weightGrams: totalWeightGrams,
          declaredValue: args.declaredValue,
        });

        const prefill = {
          items,
          totalWeightGrams,
          hasRealWeightData,
          shipping: {
            options: quote.options,
            cheapestPriceARS: quote.cheapestPriceARS,
            activeCourierCount: quote.activeCourierCount,
            originPostalCode: args.originPostalCode,
            destinationPostalCode: args.destinationPostalCode,
            ...(quote.partialFailures ? { partialFailures: quote.partialFailures } : {}),
          },
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(prefill) }],
          structuredContent: { prefill },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        return errResponse("SHIPMENT_PREP_ERROR", message);
      }
    },
  );
}
