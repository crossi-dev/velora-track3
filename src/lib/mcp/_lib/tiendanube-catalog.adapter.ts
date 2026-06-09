// src/lib/mcp/_lib/tiendanube-catalog.adapter.ts — Tiendanube CatalogBackend adapter.
//
// Implements the CatalogBackend port against the Tiendanube REST API so that
// create_product, edit_product, delete_product, adjust_stock, and bulk_price_update
// operate on a real Tiendanube store instead of the Velora DB.
//
// HTTP client, credential loading, and shared auth/URL helpers live in
// tiendanube-ventas.client.ts.
//
// NOT SUPPORTED on Tiendanube (honest errResponse, not fake success):
//   - stock_load: TN has no concept of inbound supplier purchase with cost tracking.
//     Callers should use adjust_stock for quantity corrections.
//
// FIELD MAPPING:
//   costPrice → dropped (TN has no cost-price field).
//   weightGrams → mapped to product.weight if provided.
//   TN products always have ≥1 variant; we manage variants[0] for single-SKU use.
//   bulk_price_update → PATCH /products/stock-price (≤50 variants/call); percent/fixed
//   modes computed client-side (TN takes absolute prices). "set" passed through.
//
// Source: tiendanube.github.io/api-documentation (verified 2026-06-08).

import type {
  CatalogBackend,
  CreateProductInput,
  CreateProductOutput,
  EditProductInput,
  EditProductOutput,
  StockLoadInput,
  StockLoadOutput,
  AdjustStockInput,
  AdjustStockOutput,
  DeleteProductInput,
  DeleteProductOutput,
  BulkPriceUpdateInput,
  BulkPriceUpdateOutput,
} from "./catalog-backend.port";
import {
  loadTiendanubeCredentials,
  tiendanubeBaseUrl,
  tiendanubeRequest,
  fetchAllTiendanubeProducts,
  type TiendanubeProduct,
  type TiendanubeBulkStockPriceEntry,
} from "./tiendanube-ventas.client";

// ── Internal TN shapes for mutations ─────────────────────────────────────────

interface TnCreateProductBody {
  name: { es: string };
  variants: [{
    price: string;
    stock: number;
    weight?: string;
  }];
  weight?: string;
}

interface TnUpdateProductBody {
  name?: { es: string };
  variants?: [{ price?: string; stock?: number }];
}

// ── Credential guard ──────────────────────────────────────────────────────────

async function requireCredentials(tenantId: string) {
  const credentials = await loadTiendanubeCredentials(tenantId);
  if (!credentials) {
    throw new Error(
      "TIENDANUBE_NOT_CONNECTED: No Tiendanube credentials found for this business. " +
        "Connect via BusinessChannelCredential with provider='tiendanube'.",
    );
  }
  return credentials;
}

// ── Adapter ────────────────────────────────────────────────────────────────────

/**
 * Tiendanube CatalogBackend adapter.
 *
 * Credential setup (one-time per tenant):
 *   encryptCredential(JSON.stringify({ accessToken: "<token>", storeId: "<numericId>" }))
 *   → insert BusinessChannelCredential { businessId, provider: "tiendanube", encryptedCredentials }
 *   → set TenantToolConfig.catalog = "tiendanube"
 */
export class TiendanubeCatalogAdapter implements CatalogBackend {
  // ── create_product ──────────────────────────────────────────────────────────

  async createProduct(input: CreateProductInput): Promise<CreateProductOutput> {
    const { tenantId, name, price, weightGrams, initialStock } = input;
    const credentials = await requireCredentials(tenantId);

    const body: TnCreateProductBody = {
      name: { es: name },
      variants: [{
        price: price.toFixed(2),
        stock: initialStock,
        ...(weightGrams !== undefined ? { weight: (weightGrams / 1000).toFixed(3) } : {}),
      }],
      ...(weightGrams !== undefined ? { weight: (weightGrams / 1000).toFixed(3) } : {}),
    };

    // costPrice: NOT available in Tiendanube API. Dropped silently — no fake field.
    // Documented so callers understand the limitation.

    const url = tiendanubeBaseUrl(credentials.storeId, "products");
    const created = await tiendanubeRequest<TiendanubeProduct>(url, credentials.accessToken, "POST", body);

    const firstVariant = created.variants[0]!;
    const productName = created.name.es ?? created.name.en ?? created.name.pt ?? name;

    return {
      id: String(created.id),
      name: productName,
      price: parseFloat(firstVariant.price),
      costPrice: null,   // Not available in Tiendanube API
      sku: firstVariant.sku?.trim() || null,
      stock: created.variants.reduce((sum, v) => sum + (v.stock ?? 0), 0),
    };
  }

  // ── edit_product ────────────────────────────────────────────────────────────

  async editProduct(input: EditProductInput): Promise<EditProductOutput> {
    const { tenantId, productId, name, price, stockQuantity } = input;
    const credentials = await requireCredentials(tenantId);

    // costPrice is ignored — Tiendanube has no cost-price field.
    const hasAny = name !== undefined || price !== undefined || stockQuantity !== undefined;
    if (!hasAny) {
      throw new Error(
        "EDIT_PRODUCT_VALIDATION: At least one of name, price, or stockQuantity must be provided.",
      );
    }

    const productBody: TnUpdateProductBody = {};
    if (name !== undefined) productBody.name = { es: name };

    // Price and stock live on the variant. We fetch the product first to get variants[0].id.
    const productUrl = tiendanubeBaseUrl(credentials.storeId, `products/${productId}`);

    if (price !== undefined || stockQuantity !== undefined) {
      // Fetch product to get variant id
      const existing = await tiendanubeRequest<TiendanubeProduct>(
        productUrl, credentials.accessToken,
      );
      const variantId = existing.variants[0]?.id;
      if (variantId === undefined) {
        throw new Error(`PRODUCT_NOT_FOUND: Product ${productId} has no variants.`);
      }

      const variantBody: Record<string, unknown> = {};
      if (price !== undefined) variantBody.price = price.toFixed(2);
      if (stockQuantity !== undefined) variantBody.stock = stockQuantity;

      const variantUrl = tiendanubeBaseUrl(
        credentials.storeId, `products/${productId}/variants/${variantId}`,
      );
      await tiendanubeRequest(variantUrl, credentials.accessToken, "PUT", variantBody);
    }

    // Apply name update at the product level if requested
    if (name !== undefined) {
      await tiendanubeRequest(productUrl, credentials.accessToken, "PUT", productBody);
    }

    const resolvedName = name ?? `Product ${productId}`;
    return { productId, productName: resolvedName, ok: true };
  }

  // ── stock_load ──────────────────────────────────────────────────────────────
  //
  // NOT SUPPORTED: Tiendanube has no concept of an inbound supplier purchase with
  // cost/supplier tracking. This is a Velora cash-register + inventory concept.
  // Use adjust_stock for simple stock quantity corrections.

  async stockLoad(_input: StockLoadInput): Promise<StockLoadOutput> {
    throw new Error(
      "TIENDANUBE_NOT_SUPPORTED: stock_load (inbound supplier load with cost tracking) " +
        "is not supported on Tiendanube. " +
        "Use adjust_stock to set a product's stock quantity directly.",
    );
  }

  // ── adjust_stock ────────────────────────────────────────────────────────────

  async adjustStock(input: AdjustStockInput): Promise<AdjustStockOutput> {
    const { tenantId, productId, quantity } = input;
    // Only mode "set" is in the port contract — enforce it here.
    if (input.mode !== "set") {
      throw new Error(`TIENDANUBE_NOT_SUPPORTED: adjust_stock mode "${input.mode}" is not supported.`);
    }
    const credentials = await requireCredentials(tenantId);

    // Fetch the product to get variants[0].id and the product name.
    const productUrl = tiendanubeBaseUrl(credentials.storeId, `products/${productId}`);
    const existing = await tiendanubeRequest<TiendanubeProduct>(productUrl, credentials.accessToken);

    const variantId = existing.variants[0]?.id;
    if (variantId === undefined) {
      throw new Error(`PRODUCT_NOT_FOUND: Product ${productId} has no variants on Tiendanube.`);
    }

    const variantUrl = tiendanubeBaseUrl(
      credentials.storeId, `products/${productId}/variants/${variantId}`,
    );
    await tiendanubeRequest(variantUrl, credentials.accessToken, "PUT", { stock: quantity });

    const productName = existing.name.es ?? existing.name.en ?? existing.name.pt ?? `Product ${productId}`;
    return { productId, productName, newStock: quantity, mode: "set", ok: true };
  }

  // ── delete_product ──────────────────────────────────────────────────────────

  async deleteProduct(input: DeleteProductInput): Promise<DeleteProductOutput> {
    const { tenantId, productId } = input;
    const credentials = await requireCredentials(tenantId);

    const url = tiendanubeBaseUrl(credentials.storeId, `products/${productId}`);
    await tiendanubeRequest(url, credentials.accessToken, "DELETE");

    // Tiendanube DELETE is a hard delete (no "archived" concept like Velora).
    return { productId, archived: false, ok: true };
  }

  // ── bulk_price_update ───────────────────────────────────────────────────────
  //
  // TN endpoint: PATCH /products/stock-price  (up to 50 variants per call)
  // Source: tiendanube.github.io/api-documentation/resources/product
  //
  // Since TN takes absolute prices, percent and fixed modes are computed client-side
  // after fetching current prices. The "set" direction passes the amount as-is.

  async bulkPriceUpdate(input: BulkPriceUpdateInput): Promise<BulkPriceUpdateOutput> {
    const { tenantId, amount, mode, direction, productIds } = input;
    const credentials = await requireCredentials(tenantId);

    // 1. Fetch current products to compute new prices.
    //    TN has no server-side "ids=" filter — always fetch all, then filter client-side.
    //    fetchAllTiendanubeProducts paginates correctly (page=1..N, per_page=200, max 10 pages).
    const allProducts = await fetchAllTiendanubeProducts(credentials);

    const targetProducts = productIds?.length
      ? allProducts.filter((p) => productIds.includes(String(p.id)))
      : allProducts;

    if (targetProducts.length === 0) {
      throw new Error("NO_PRODUCTS_FOUND: No matching products found for bulk price update.");
    }

    // 2. Build variant entries with new prices.
    const entries: TiendanubeBulkStockPriceEntry[] = [];
    for (const p of targetProducts) {
      for (const v of p.variants) {
        const currentPrice = parseFloat(v.price);
        if (isNaN(currentPrice)) continue;

        let newPrice: number;
        if (direction === "set") {
          newPrice = amount;
        } else if (mode === "percent") {
          const delta = currentPrice * (amount / 100);
          newPrice = direction === "up" ? currentPrice + delta : currentPrice - delta;
        } else {
          // mode === "fixed"
          newPrice = direction === "up" ? currentPrice + amount : currentPrice - amount;
        }

        // Clamp to minimum 0.01 — TN rejects zero/negative prices.
        newPrice = Math.max(0.01, Math.round(newPrice * 100) / 100);
        entries.push({ id: v.id, price: newPrice.toFixed(2) });
      }
    }

    // 3. Send in batches of 50 (TN maximum).
    const TN_BULK_BATCH = 50;
    let batchCount = 0;
    for (let i = 0; i < entries.length; i += TN_BULK_BATCH) {
      const batch = entries.slice(i, i + TN_BULK_BATCH);
      const bulkUrl = tiendanubeBaseUrl(credentials.storeId, "products/stock-price");
      // TN API requires object wrapper: { products: [...] }
      // Source: tiendanube.github.io/api-documentation/resources/product#update-stock-and-price
      await tiendanubeRequest(bulkUrl, credentials.accessToken, "PATCH", { products: batch });
      batchCount++;
    }

    const summary =
      `Updated prices for ${targetProducts.length} product(s) ` +
      `(${entries.length} variant(s)) via Tiendanube ` +
      `in ${batchCount} batch(es). Mode: ${mode} ${direction} ${amount}${mode === "percent" ? "%" : ""}.`;

    return { count: targetProducts.length, summary, ok: true };
  }
}
