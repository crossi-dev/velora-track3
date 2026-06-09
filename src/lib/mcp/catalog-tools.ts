// src/lib/mcp/catalog-tools.ts — Stateful catalog + stock WRITE tools.
//
// Registers six tenant-scoped mutation tools on a McpServer instance:
//   - create_product    : creates a product via the canonical create-product use-case.
//   - edit_product      : updates name/price/costPrice/stock of an existing product.
//   - stock_load        : records inbound stock from a supplier via the stock-load use-case.
//   - adjust_stock      : sets absolute stock for a product (scoped by businessId).
//   - delete_product    : soft-archives (or hard-deletes) a product via the delete-product use-case.
//   - bulk_price_update : mass price change for all products or a target subset.
//
// SECURITY: businessId ALWAYS from the closure — NEVER from tool input.
// Idempotency keys are SERVER-DERIVED from (businessId, tool, stable args).
// All mutations delegate to VeloraCatalogAdapter via the CatalogBackend port.
//
// References:
//   create-product.use-case           — src/application/use-cases/create-product.use-case.ts
//   update-product.use-case           — src/application/use-cases/update-product.use-case.ts
//   create-stock-load.use-case        — src/application/use-cases/create-stock-load.use-case.ts
//   delete-product.use-case           — src/application/use-cases/delete-product.use-case.ts
//   bulk-update-product-prices.use-case — src/application/use-cases/bulk-update-product-prices.use-case.ts

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { errResponse } from "./_lib/catalog-mutations";
import type { CatalogBackend } from "./_lib/catalog-backend.port";
import { createCatalogBackend } from "./_lib/catalog-backend.factory";
import { bulkPriceGuard } from "./_lib/bulk-price-guard";

// Domain error code → human message for bulk_price_update.
const BULK_PRICE_DOMAIN: Record<string, string> = {
  NO_PRODUCTS_FOUND: "No matching products found for this business.",
};

// Shared idempotency error messages — mirrors sales-mutations.ts convention.
function idempotencyErrResponse(message: string) {
  if (message === "IDEMPOTENCY_CONFLICT") return errResponse("IDEMPOTENCY_CONFLICT", "Idempotency key conflict.");
  if (message === "IDEMPOTENCY_IN_FLIGHT") return errResponse("IDEMPOTENCY_IN_FLIGHT", "Concurrent operation in progress.");
  if (message === "IDEMPOTENCY_MISSING") return errResponse("IDEMPOTENCY_MISSING", "Missing idempotency key.");
  return null;
}

/**
 * Registers create_product, edit_product, stock_load, adjust_stock, delete_product,
 * and bulk_price_update on the given server.
 * Called only when a verified businessId is available from the auth gate.
 *
 * @param backend Optional CatalogBackend override for testing or future backend variants.
 *   Defaults to createCatalogBackend() which reads CATALOG_BACKEND env var (default "velora").
 */
export function registerCatalogTools(
  server: McpServer,
  businessId: string,
  backend: CatalogBackend = createCatalogBackend(),
): void {
  // ── Tool: create_product ───────────────────────────────────────────────────
  // Standard MCP tool: server.registerTool + spec annotations (readOnlyHint /
  // idempotentHint / destructiveHint / openWorldHint).
  // Source: https://modelcontextprotocol.io/specification/2025-06-18/server/tools
  server.registerTool(
    "create_product",
    {
      title: "Create product",
      description:
        "Use this when the owner wants to add a new product to their catalog. " +
        "Creates a new product in the business catalog. Requires name and price. " +
        "initialStock defaults to 0. costPrice and weightGrams are optional. " +
        "Returns the created product with id, name, price, costPrice, sku, and stock. " +
        "Idempotent: calling twice with the same name+price deduplicates.",
      inputSchema: {
        name: z.string().min(1).describe("Product name."),
        price: z.number().positive().describe("Selling price in ARS."),
        costPrice: z.number().positive().optional().describe("Purchase cost price in ARS (optional)."),
        weightGrams: z.number().int().positive().optional().describe("Weight in grams (optional)."),
        initialStock: z.number().int().min(0).default(0).describe("Initial stock quantity (default 0)."),
      },
      // destructiveHint: false — additive create of a NEW product row; existing data untouched, reversible via delete_product (bulk upload_catalog is marked true).
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (args) => {
      try {
        const out = await backend.createProduct({ tenantId: businessId, ...args });
        return { content: [{ type: "text" as const, text: JSON.stringify(out) }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        return idempotencyErrResponse(message) ?? errResponse("CREATE_PRODUCT_ERROR", message);
      }
    },
  );

  // ── Tool: edit_product ────────────────────────────────────────────────────
  server.registerTool(
    "edit_product",
    {
      title: "Edit product",
      description:
        "Use this when the owner wants to change a specific product's name, price, cost, or stock. " +
        "For bulk price changes use `bulk_price_update`; for stock-only changes prefer `adjust_stock` or `stock_load`. " +
        "Updates a single product's fields (name, price, costPrice, or stockQuantity). " +
        "productId MUST belong to this business — foreign IDs return not-found (isError). " +
        "At least one of name, price, costPrice, or stockQuantity must be provided. " +
        "When stockQuantity is provided, it replaces the current stock (set mode).",
      inputSchema: {
        productId: z.string().min(1).describe("ID of the product to update (must belong to this business)."),
        name: z.string().min(1).optional().describe("New product name (optional)."),
        price: z.number().positive().optional().describe("New selling price in ARS (optional)."),
        costPrice: z.number().positive().nullable().optional().describe("New cost price in ARS, or null to clear (optional)."),
        stockQuantity: z.number().int().min(0).optional().describe("Set stock to this value (optional)."),
      },
      // Spec ToolAnnotations: https://modelcontextprotocol.io/specification/2025-06-18/schema
      // destructiveHint: true — overwrites existing price/name/stock fields; overwrite is irreversible without a second call.
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const out = await backend.editProduct({ tenantId: businessId, ...args });
        return { content: [{ type: "text" as const, text: JSON.stringify(out) }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        if (message === "EDIT_PRODUCT_VALIDATION") {
          return errResponse("EDIT_PRODUCT_VALIDATION", "At least one field (name, price, costPrice, stockQuantity) must be provided.");
        }
        if (message === "PRODUCT_NOT_FOUND") return errResponse("PRODUCT_NOT_FOUND", "Product not found in this business.");
        return idempotencyErrResponse(message) ?? errResponse("EDIT_PRODUCT_ERROR", message);
      }
    },
  );

  // ── Tool: stock_load ──────────────────────────────────────────────────────
  server.registerTool(
    "stock_load",
    {
      title: "Stock load",
      description:
        "Use this when stock arrives from a supplier or you need to record an initial stock-in. " +
        "Choose this over adjust_stock when you want an audit trail of inbound goods (cost + supplier). " +
        "Records inbound stock for a product — restock or initial stock. Resolves or auto-creates " +
        "the product by name if autoCreateProduct is true and a unitPrice is provided. " +
        "supplierId/supplierName are OPTIONAL: include them only when the stock comes from a known " +
        "supplier; omit them entirely for initial stock with no supplier. " +
        "Optionally creates a purchase request for the supplier when createPurchaseRequest is true (needs a supplier). " +
        "When createPurchaseRequest is true but no supplier is given, the response includes requestSkipped: 'no_supplier_provided'.",
      inputSchema: {
        productId: z.string().optional().describe("Existing product ID (optional if itemName resolves it)."),
        itemName: z.string().min(1).describe("Product name for resolution or auto-creation."),
        supplierId: z.string().optional().describe("Existing supplier ID. OPTIONAL — omit if there is no supplier."),
        supplierName: z.string().optional().describe("Supplier name. OPTIONAL — omit if there is no supplier."),
        quantity: z.number().int().positive().describe("Units received."),
        unitPrice: z.number().min(0).optional().describe("Cost per unit in ARS (required for auto-create)."),
        autoCreateProduct: z.boolean().default(false).describe("Auto-create product if not found (requires unitPrice)."),
        createPurchaseRequest: z.boolean().default(false).describe("Also create a purchase request for this stock load."),
      },
      // Spec ToolAnnotations: https://modelcontextprotocol.io/specification/2025-06-18/schema
      // destructiveHint: true — records an irreversible inbound stock movement (StockMovement row).
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const data = await backend.stockLoad({ tenantId: businessId, ...args });
        return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        return idempotencyErrResponse(message) ?? errResponse("STOCK_LOAD_ERROR", message);
      }
    },
  );

  // ── Tool: adjust_stock ────────────────────────────────────────────────────
  server.registerTool(
    "adjust_stock",
    {
      title: "Adjust stock",
      description:
        "Use this when you need to set the exact stock count for an inventory sync or correction (no audit trail). " +
        "Choose stock_load instead when receiving goods from a supplier — it keeps an inbound movement record. " +
        "Sets the absolute stock quantity for a product (inventory sync). " +
        "productId must belong to this business — foreign IDs return not-found (isError). " +
        "quantity is the new absolute target (e.g. 50 means the shelf now has 50 units). " +
        "Relative increase/decrease is not supported via MCP — use stock_load for inbound.",
      inputSchema: {
        productId: z.string().min(1).describe("Product ID to update (must belong to this business)."),
        mode: z.literal("set").describe("Must be 'set'. Absolute-set is the only race-safe mode available via MCP."),
        quantity: z.number().int().min(0).describe("New absolute stock quantity."),
      },
      // Spec ToolAnnotations: https://modelcontextprotocol.io/specification/2025-06-18/schema
      // destructiveHint: true — overwrites the absolute stock quantity; prior value is not recoverable without a second call.
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const out = await backend.adjustStock({ tenantId: businessId, ...args });
        return { content: [{ type: "text" as const, text: JSON.stringify(out) }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        if (message === "PRODUCT_NOT_FOUND") return errResponse("PRODUCT_NOT_FOUND", "Product not found in this business.");
        return idempotencyErrResponse(message) ?? errResponse("ADJUST_STOCK_ERROR", message);
      }
    },
  );

  // ── Tool: delete_product ──────────────────────────────────────────────────
  server.registerTool(
    "delete_product",
    {
      title: "Delete product",
      description:
        "Deletes (or soft-archives) a product from the catalog. " +
        "Products with associated sale records are soft-archived (archived=true); " +
        "products without sales are hard-deleted. " +
        "productId must belong to this business — foreign IDs return PRODUCT_NOT_FOUND (isError). " +
        "Returns { productId, archived, ok } on success. Idempotent: repeat calls deduplicate.",
      inputSchema: {
        productId: z.string().min(1).describe("ID of the product to delete (must belong to this business)."),
      },
      // Spec ToolAnnotations: https://modelcontextprotocol.io/specification/2025-06-18/schema
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const out = await backend.deleteProduct({ tenantId: businessId, productId: args.productId });
        return { content: [{ type: "text" as const, text: JSON.stringify(out) }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        if (message === "PRODUCT_NOT_FOUND") return errResponse("PRODUCT_NOT_FOUND", "Product not found in this business.");
        return idempotencyErrResponse(message) ?? errResponse("DELETE_PRODUCT_ERROR", message);
      }
    },
  );

  // ── Tool: bulk_price_update ───────────────────────────────────────────────
  server.registerTool(
    "bulk_price_update",
    {
      title: "Bulk price update",
      description:
        "Use this when the owner wants to raise, lower, or set prices across MANY products at once. For a single product, use `edit_product`. " +
        "Mass price change for all products or a specified subset in this business. " +
        "mode='percent': amount is a percentage (e.g. 10 = 10%). " +
        "mode='fixed': amount is an absolute ARS amount. " +
        "direction='up' raises prices; direction='down' lowers them; direction='set' sets an exact price (mode is ignored when direction='set'). " +
        "productIds: target specific products by ID; omit to apply to ALL products. " +
        "Returns { count, summary, ok } on success. Idempotent: same args deduplicates.",
      inputSchema: {
        amount: z.number().positive().describe("Adjustment amount — percentage (e.g. 10 for 10%) or fixed ARS value depending on mode."),
        mode: z.enum(["percent", "fixed"]).describe("'percent' = percentage change; 'fixed' = absolute ARS change."),
        direction: z.enum(["up", "down", "set"]).describe("'up' raises prices; 'down' lowers them; 'set' assigns an exact price."),
        productIds: z
          .array(z.string().min(1))
          .optional()
          .describe("Specific product IDs to update (must belong to this business). Omit to update ALL products."),
      },
      // Spec ToolAnnotations: https://modelcontextprotocol.io/specification/2025-06-18/schema
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: true, openWorldHint: false },
    },
    async (args) => {
      const guardError = bulkPriceGuard(args);
      if (guardError) return guardError;
      try {
        const out = await backend.bulkPriceUpdate({ tenantId: businessId, ...args });
        return { content: [{ type: "text" as const, text: JSON.stringify(out) }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        return (
          idempotencyErrResponse(message) ??
          errResponse("BULK_PRICE_UPDATE_ERROR", BULK_PRICE_DOMAIN[message] ?? message)
        );
      }
    },
  );
}
