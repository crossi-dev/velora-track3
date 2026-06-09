// src/lib/mcp/_lib/tiendanube-ventas.adapter.ts — READ-ONLY Tiendanube (Nuvemshop) catalog adapter.
//
// Implements the VentasBackend port using the Tiendanube REST API so that
// query_catalog can read a real Tiendanube store's products instead of Velora DB.
//
// HTTP client, credential loading, and raw API types live in tiendanube-ventas.client.ts.
//
// VARIANT MAPPING DECISION:
//   Multi-variant Tiendanube products (e.g. sizes/colors) are flattened into ONE catalog
//   entry per product. Mapping:
//     - price  = parseFloat(variants[0].price)   — first variant's price
//     - stock  = sum of all variants[].stock      — total available stock across variants
//     - sku    = variants[0].sku || null           — first variant's SKU
//   This is a KNOWN simplification. Full per-variant support (separate catalog entry per
//   variant, with color/size labels) is a tracked follow-up — it requires the MCP tool
//   contract to surface variant-level data, which the current CatalogProductResult shape
//   does not have.
//
// READ-ONLY: only queryCatalog is implemented. getLowStockProducts and getProductStock
//   throw a "not implemented" error because:
//   (a) Tiendanube has no direct low-stock query endpoint (would require client-side filter
//       after full catalog fetch — expensive and outside read-once contract)
//   (b) getProductStock by Velora productId has no Tiendanube equivalent (different ID space)
//   These methods are implemented in VeloraVentasAdapter and can be delegated there if needed.

import type {
  VentasBackend,
  QueryCatalogInput,
  CatalogProductResult,
  GetLowStockProductsInput,
  LowStockProductResult,
  GetProductStockInput,
  ProductStockResult,
} from "./ventas-backend.port";
import {
  type TiendanubeProduct,
  loadTiendanubeCredentials,
  fetchAllTiendanubeProducts,
} from "./tiendanube-ventas.client";

// ── Mapping: TiendanubeProduct → CatalogProductResult ─────────────────────────

/**
 * Maps a Tiendanube Product to the flat CatalogProductResult shape.
 *
 * VARIANT MAPPING DECISION (see module header for full rationale):
 *   price    = parseFloat(variants[0].price)   — first variant's price
 *   stock    = sum of all variants[].stock      — total stock across all variants
 *   sku      = variants[0].sku || null           — first variant's SKU
 *   costPrice / weightGrams not available in TN API → always null
 */
function mapTiendanubeProduct(product: TiendanubeProduct): CatalogProductResult | null {
  // Guard: skip products with no variants (shouldn't happen per TN API but defensive).
  if (!product.variants || product.variants.length === 0) return null;

  const firstVariant = product.variants[0]!;

  // Name: prefer es, fallback en, then pt, then a safe placeholder.
  const name =
    product.name.es ??
    product.name.en ??
    product.name.pt ??
    "(sin nombre)";

  // Price: first variant, string → number. Tiendanube stores prices as decimal strings.
  const price = parseFloat(firstVariant.price);
  if (isNaN(price)) return null; // skip malformed variant price

  // Stock: sum across all variants so multi-variant products show total available stock.
  const stock = product.variants.reduce((sum, v) => sum + (v.stock ?? 0), 0);

  // SKU: first variant's SKU. Empty string → null for consistency with CatalogProductResult.
  const sku = firstVariant.sku?.trim() || null;

  return {
    id: String(product.id),
    name,
    price,
    costPrice: null,     // Not available in Tiendanube API
    sku,
    stock,
    weightGrams: null,   // Not available in Tiendanube API
  };
}

// ── Adapter ────────────────────────────────────────────────────────────────────

/**
 * READ-ONLY Tiendanube VentasBackend adapter.
 *
 * Only queryCatalog is implemented. The other port methods (getLowStockProducts,
 * getProductStock) are Velora-specific concepts with no direct Tiendanube equivalent
 * and throw a clear "not implemented (read-only adapter)" error.
 *
 * Selection: pass "tiendanube" as the tenantOverride to createVentasBackend(), or
 * set VENTAS_BACKEND=tiendanube globally (not recommended — prefer per-tenant config
 * via TenantToolConfig.ventas = "tiendanube" in the DB).
 *
 * Token setup (per tenant, one-time):
 *   1. Obtain Tiendanube OAuth access token + numeric storeId from the Tiendanube app.
 *   2. Run: encryptCredential(JSON.stringify({ accessToken: "<token>", storeId: "<id>" }))
 *   3. Insert: BusinessChannelCredential { businessId, provider: "tiendanube",
 *                encryptedCredentials: <result from step 2>, environment: "production" }
 *   4. Set TenantToolConfig.ventas = "tiendanube" for that businessId.
 */
export class TiendanubeVentasAdapter implements VentasBackend {
  /**
   * Fetches and returns catalog products from the Tiendanube store connected to
   * the given tenant. Supports optional name search (case-insensitive substring).
   *
   * Throws when:
   *   - No credential row exists for the tenant (TIENDANUBE_NOT_CONNECTED)
   *   - Tiendanube API returns a non-2xx status
   *   - Decryption of stored credentials fails (tampered ciphertext)
   */
  async queryCatalog(input: QueryCatalogInput): Promise<CatalogProductResult[]> {
    const { tenantId: businessId, search } = input;

    const credentials = await loadTiendanubeCredentials(businessId);
    if (!credentials) {
      throw new Error(
        "TIENDANUBE_NOT_CONNECTED: No Tiendanube credentials found for this business. " +
          "Connect via BusinessChannelCredential with provider='tiendanube'.",
      );
    }

    const rawProducts = await fetchAllTiendanubeProducts(credentials);

    // Map all products, dropping any that fail mapping (malformed variant price etc.)
    const mapped: CatalogProductResult[] = [];
    for (const p of rawProducts) {
      const result = mapTiendanubeProduct(p);
      if (result !== null) mapped.push(result);
    }

    // Apply optional name search filter (case-insensitive substring, mirrors Velora adapter).
    if (search && search.trim().length > 0) {
      const needle = search.trim().toLowerCase();
      return mapped.filter((p) => p.name.toLowerCase().includes(needle));
    }

    return mapped;
  }

  /**
   * NOT IMPLEMENTED — read-only Tiendanube adapter.
   *
   * getLowStockProducts requires filtering by reorderThreshold, which is a
   * Velora-specific concept. Tiendanube has no equivalent endpoint.
   * Use VeloraVentasAdapter for this method.
   */
  async getLowStockProducts(_input: GetLowStockProductsInput): Promise<LowStockProductResult[]> {
    throw new Error(
      "TiendanubeVentasAdapter: getLowStockProducts is not implemented (read-only adapter). " +
        "This method requires Velora-specific reorderThreshold data. " +
        "Use VeloraVentasAdapter for low-stock queries.",
    );
  }

  /**
   * NOT IMPLEMENTED — read-only Tiendanube adapter.
   *
   * getProductStock by Velora productId has no direct equivalent in Tiendanube
   * (different ID spaces). Use VeloraVentasAdapter for this method.
   */
  async getProductStock(_input: GetProductStockInput): Promise<ProductStockResult | null> {
    throw new Error(
      "TiendanubeVentasAdapter: getProductStock is not implemented (read-only adapter). " +
        "Tiendanube IDs differ from Velora product IDs. " +
        "Use VeloraVentasAdapter for stock lookups by Velora product ID.",
    );
  }
}
