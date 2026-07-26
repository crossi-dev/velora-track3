// src/lib/mcp/ventas-tools.ts — Stateful Ventas MCP tool registrations (read-only).
//
// Registers two tenant-scoped tools on a McpServer instance:
//   - query_catalog         : lists active products for the business (optional name search).
//                             Each product includes its stock quantity — use this instead of
//                             the removed get_stock tool (which was redundant).
//   - open_catalog_selector : render tool (side-effect-free) that opens the catalog selector
//                             widget pre-loaded with UCP-shaped products for visual browsing.
//
// These tools require a resolved businessId (from the auth gate) and are only
// registered when one is provided. They are READ-ONLY — no mutations are exposed.
//
// Tenant isolation: businessId ALWAYS comes from the closure — never from tool input.
// The query functions in ./_lib/ventas-queries.ts scope every DB call by businessId.
//
// Error surface: DB failures return isError: true with { code, message } — tools do
// NOT throw on infra failure so LLM callers can detect and report them cleanly.
//
// References:
//   queryCatalog — ./_lib/ventas-queries.ts
//   buildActiveProductWhere (used by queries) — src/infrastructure/shared/product-sku.ts
//   VentasBackend port      — ./_lib/ventas-backend.port.ts
//   UCP Catalog spec        — https://ucp.dev/latest/specification/catalog/

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerAppTool, registerAppResource, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import type { VentasBackend, CatalogProductResult } from "./_lib/ventas-backend.port";
import { createVentasBackend } from "./_lib/ventas-backend.factory";
import { CATALOG_SELECTOR_HTML } from "./widgets/generated/catalog-selector.html";
import { errResponse } from "./_lib/mcp-responses";
/** Canonical ui:// URI for the catalog selector widget resource. */
const CATALOG_SELECTOR_RESOURCE_URI = "ui://catalog-selector";

// ── UCP Catalog mapping ───────────────────────────────────────────────────────
//
// Velora products are flat (no per-variant options) → mapped to a single UCP
// variant per product. Full per-variant support is a follow-up (same as the
// Tiendanube adapter note in ventas-backend.factory.ts).
//
// UCP Catalog spec: https://ucp.dev/latest/specification/catalog/
//   price_range.min/max.amount = integer minor units (centavos ARS = pesos × 100)
//   currency = ISO 4217 code ("ARS")

interface UCPAmount {
  amount: number;
  currency: string;
}

interface UCPProduct {
  id: string;
  title: string;
  description: string;
  price_range: { min: UCPAmount; max: UCPAmount };
  variants: Array<{
    id: string;
    sku?: string;
    availability: { in_stock: boolean; quantity?: number };
    price: UCPAmount;
  }>;
}

function toUCPProduct(p: CatalogProductResult): UCPProduct {
  const centavos = Math.round(p.price * 100);
  const priceAmount: UCPAmount = { amount: centavos, currency: "ARS" };
  return {
    id: p.id,
    title: p.name,
    // Velora has no separate description field; title is the best available proxy.
    description: p.name,
    price_range: { min: priceAmount, max: priceAmount },
    variants: [
      {
        id: `${p.id}:default`,
        // Only include sku when present (UCP variant.sku is optional)
        ...(p.sku ? { sku: p.sku } : {}),
        availability: { in_stock: p.stock > 0, quantity: p.stock },
        price: priceAmount,
      },
    ],
  };
}

// ── Registration helper ───────────────────────────────────────────────────────

/**
 * Registers query_catalog and open_catalog_selector on the given server.
 * Called only when a verified businessId is available from the auth gate.
 *
 * @param backend Optional VentasBackend override for testing or future backend variants.
 *   Defaults to createVentasBackend() which reads VENTAS_BACKEND env var (default "velora").
 *   Callers at src/lib/mcp/server.ts pass no backend — behavior is byte-for-byte identical
 *   to before this seam was introduced.
 */
export function registerVentasTools(
  server: McpServer,
  businessId: string,
  backend: VentasBackend = createVentasBackend(),
): void {
  // ── Tool: query_catalog ────────────────────────────────────────────────────
  server.registerTool(
    "query_catalog",
    {
      title: "Query catalog",
      description:
        "Use this to look up products and prices before recording a sale or creating a payment link. " +
        "Lists active products in the business catalog. Returns up to 50 products sorted " +
        "by name, each with id, name, price (ARS), costPrice, sku, stock quantity, and " +
        "weightGrams. costPrice and weightGrams may be null when not set by the business. " +
        "When search is provided, filters to products whose name contains " +
        "the search string (case-insensitive). Returns an empty array when no products match. " +
        "Returns JSON — use to resolve product IDs/prices for chaining into other tools. For a visual interactive catalog, use open_catalog_selector.",
      inputSchema: {
        search: z
          .string()
          .optional()
          .describe("Optional name filter (case-insensitive substring match)."),
      },
      // Spec ToolAnnotations: https://modelcontextprotocol.io/specification/2025-06-18/schema
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (args) => {
      try {
        const products = await backend.queryCatalog({ tenantId: businessId, search: args.search });
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ products, total: products.length }) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        return errResponse("CATALOG_QUERY_ERROR", message);
      }
    },
  );

  // ── Resource: ui://catalog-selector (authored MCP App widget) ───────────────
  // Self-contained HTML (React widget bundled by scripts/build-widget.mjs). The
  // host renders it fullscreen in a sandboxed iframe. Static — no tenant data.
  registerAppResource(
    server,
    "Selector de catálogo",
    CATALOG_SELECTOR_RESOURCE_URI,
    // _meta.ui.csp: official MCP Apps sandbox CSP field (claude.com/docs/connectors/
    // building/mcp-apps/design-guidelines#content-security-policy). Self-contained widget
    // → no external origins needed. Without this the host shows "CSP desact." and skips render.
    { _meta: { ui: { csp: { connectDomains: [], resourceDomains: [], frameDomains: [] } } } },
    (uri) => ({
      contents: [{ uri: uri.href, mimeType: RESOURCE_MIME_TYPE, text: CATALOG_SELECTOR_HTML }],
    }),
  );

  // ── Tool: open_catalog_selector (RENDER — side-effect-free) ─────────────────
  // Fetches products via the VentasBackend port, maps them to UCP Catalog shape,
  // and pre-fills the catalog selector widget. The widget is a pure picker —
  // no money ops. The owner confirms a selection, which surfaces as a summary
  // the model reads to continue (e.g., to call open_payment_link_wizard).
  //
  // businessId comes from the closure — never from tool input (tenant isolation).
  registerAppTool(
    server,
    "open_catalog_selector",
    {
      title: "Open catalog selector",
      description:
        "Use this when the owner wants to visually browse and pick products with a graphical interface. " +
        "Opens the catalog selector — a graphical product picker that shows all active products " +
        "with prices (ARS) and stock, lets the owner pick quantities, and surfaces the selection " +
        "as a summary the model reads to continue. Side-effect-free (no sale, no charge). " +
        "Optional search filter to narrow the product list. " +
        "Products are mapped to UCP Catalog shape (ucp.dev/latest/specification/catalog/).",
      // openai/outputTemplate is ChatGPT's PRIMARY render key (developers.openai.com/apps-sdk/build/custom-ux);
      // ui.resourceUri is the MCP-Apps standard key for other hosts. Both point to the same ui:// resource.
      _meta: { ui: { resourceUri: CATALOG_SELECTOR_RESOURCE_URI }, "openai/outputTemplate": CATALOG_SELECTOR_RESOURCE_URI },
      // outputSchema describes structuredContent — ChatGPT renders the widget only when the
      // tool declares it (developers.openai.com/apps-sdk/quickstart display requirements).
      outputSchema: { prefill: z.object({}).passthrough() },
      inputSchema: {
        search: z
          .string()
          .optional()
          .describe("Optional name filter passed to the catalog query (case-insensitive substring match)."),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (args) => {
      try {
        const raw = await backend.queryCatalog({ tenantId: businessId, search: args.search });
        const products = raw.map(toUCPProduct);
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ products, total: products.length }) }],
          structuredContent: { prefill: { products } },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        return errResponse("CATALOG_QUERY_ERROR", message);
      }
    },
  );
}
