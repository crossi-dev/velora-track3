// src/lib/mcp/_lib/catalog-backend.port.ts — Backend-agnostic port for catalog MCP tools.
//
// Decouples the 4 catalog write tools from Velora's concrete use-case layer.
// A future FudoCatalogAdapter (or any other backend) implements this interface
// and requires ZERO changes to catalog-tools.ts or the MCP server.
//
// Design mirrors engine-adapter.ts / engine-factory.ts:
//   port (this file) → adapter (velora-catalog.adapter.ts) → factory (catalog-backend.factory.ts)
//
// tenantId is opaque here — the Velora adapter maps it to businessId internally
// so the port name doesn't hard-wire Velora's domain vocabulary.
//
// Input/output types are inlined from the handler signatures in catalog-mutations.ts.
// They are intentionally narrow (tool-contract shapes) — not the full domain types.
// The port is a seam, not a full domain model.

export interface CreateProductInput {
  tenantId: string;
  name: string;
  price: number;
  costPrice?: number;
  weightGrams?: number;
  initialStock: number;
}

export interface CreateProductOutput {
  id: string;
  name: string;
  price: number;
  costPrice: number | null;
  sku: string | null;
  stock: number;
}

export interface EditProductInput {
  tenantId: string;
  productId: string;
  name?: string;
  price?: number;
  costPrice?: number | null;
  stockQuantity?: number;
}

export interface EditProductOutput {
  productId: string;
  productName: string;
  ok: true;
}

export interface StockLoadInput {
  tenantId: string;
  productId?: string;
  itemName: string;
  supplierId?: string;
  supplierName?: string;
  quantity: number;
  unitPrice?: number;
  autoCreateProduct: boolean;
  createPurchaseRequest: boolean;
}

// stockLoad success data is passed through from the use-case — kept opaque at the port level.
export type StockLoadOutput = unknown;

export interface AdjustStockInput {
  tenantId: string;
  productId: string;
  mode: "set";
  quantity: number;
}

export interface AdjustStockOutput {
  productId: string;
  productName: string;
  newStock: number;
  mode: "set";
  ok: true;
}

export interface DeleteProductInput {
  tenantId: string;
  productId: string;
}

export interface DeleteProductOutput {
  productId: string;
  archived: boolean;
  ok: true;
}

export interface BulkPriceUpdateInput {
  tenantId: string;
  amount: number;
  mode: "percent" | "fixed";
  /** "up" raises prices; "down" lowers them; "set" sets an absolute price (amount used as-is). */
  direction: "up" | "down" | "set";
  /** When omitted, applies to all products in the tenant. */
  productIds?: string[];
}

export interface BulkPriceUpdateOutput {
  count: number;
  summary: string;
  ok: true;
}

/**
 * Backend-agnostic catalog port for the MCP catalog tool pack.
 *
 * Every method maps to one MCP tool (create_product, edit_product, stock_load, adjust_stock,
 * delete_product, bulk_price_update).
 * Throw an Error with a domain code (e.g. "PRODUCT_NOT_FOUND") for error-path handling —
 * catalog-tools.ts converts thrown errors to MCP isError responses.
 *
 * Tenant isolation is enforced by each adapter via the opaque tenantId field.
 */
export interface CatalogBackend {
  createProduct(input: CreateProductInput): Promise<CreateProductOutput>;
  editProduct(input: EditProductInput): Promise<EditProductOutput>;
  stockLoad(input: StockLoadInput): Promise<StockLoadOutput>;
  adjustStock(input: AdjustStockInput): Promise<AdjustStockOutput>;
  deleteProduct(input: DeleteProductInput): Promise<DeleteProductOutput>;
  bulkPriceUpdate(input: BulkPriceUpdateInput): Promise<BulkPriceUpdateOutput>;
}
