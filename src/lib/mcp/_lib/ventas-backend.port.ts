// src/lib/mcp/_lib/ventas-backend.port.ts — Backend-agnostic port for ventas MCP tools.
//
// Decouples the 2 ventas read-only tools from Velora's concrete query layer.
// A future FudoVentasAdapter (or any other backend) implements this interface
// and requires ZERO changes to ventas-tools.ts or the MCP server.
//
// Design mirrors catalog-backend.port.ts / engine-adapter.ts:
//   port (this file) → adapter (velora-ventas.adapter.ts) → factory (ventas-backend.factory.ts)
//
// tenantId is opaque here — the Velora adapter maps it to businessId internally
// so the port name doesn't hard-wire Velora's domain vocabulary.
//
// Input/output types are inlined from ventas-queries.ts.
// They are intentionally narrow (tool-contract shapes) — not the full domain types.
// The port is a seam, not a full domain model.

export interface QueryCatalogInput {
  tenantId: string;
  search?: string;
}

export interface CatalogProductResult {
  id: string;
  name: string;
  price: number;
  costPrice: number | null;
  sku: string | null;
  stock: number;
  weightGrams: number | null;
}

// ── Inventario ADK read port additions ────────────────────────────────────────
// These two methods move the inline Prisma reads from the inventario ADK tools
// behind the shared port so the tool bodies contain zero soldered DB logic.
// Both are read-only and do not touch the draft→approve / Pattern-C mutation path.

export interface GetLowStockProductsInput {
  tenantId: string;
}

export interface LowStockProductResult {
  id: string;
  name: string;
  stock: number;
  reorderThreshold: number;
}

export interface GetProductStockInput {
  tenantId: string;
  productId: string;
}

export interface ProductStockResult {
  quantity: number;
}

/**
 * Backend-agnostic ventas port for the MCP ventas tool pack.
 *
 * Methods:
 *   queryCatalog       — MCP query_catalog tool (returns stock per product)
 *   getLowStockProducts — ADK stock.consultar_stock (filter=low_stock)
 *   getProductStock    — ADK stock.gestionar_stock (action=stocktake variance read)
 *
 * Throw an Error with a domain code for error-path handling —
 * ventas-tools.ts converts thrown errors to MCP isError responses.
 *
 * Tenant isolation is enforced by each adapter via the opaque tenantId field.
 */
export interface VentasBackend {
  queryCatalog(input: QueryCatalogInput): Promise<CatalogProductResult[]>;
  getLowStockProducts(input: GetLowStockProductsInput): Promise<LowStockProductResult[]>;
  getProductStock(input: GetProductStockInput): Promise<ProductStockResult | null>;
}
