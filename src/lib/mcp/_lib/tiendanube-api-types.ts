// src/lib/mcp/_lib/tiendanube-api-types.ts — Tiendanube REST API raw response shapes.
//
// Split from tiendanube-ventas.client.ts to stay within the 300-line file-size limit.
// All shapes are confirmed against https://tiendanube.github.io/api-documentation (2026-06-08).
// Only the fields consumed by Velora adapters are listed — the actual API responses
// include many more fields that we intentionally ignore.
//
// Consumed by:
//   tiendanube-ventas.client.ts     (product types + re-exports)
//   tiendanube-catalog.adapter.ts   (TiendanubeProduct, TiendanubeBulkStockPriceEntry)
//   tiendanube-customer.adapter.ts  (TiendanubeCustomer)
//   tiendanube-sales.adapter.ts     (TiendanubeProduct, TiendanubeOrder)
//   tiendanube-reportes.adapter.ts  (TiendanubeOrder)

// ── Shared language-map shape ─────────────────────────────────────────────────

/** Language-keyed text map used for product names, descriptions, etc. */
export interface TiendanubeLocalizedString {
  es?: string;
  en?: string;
  pt?: string;
}

// ── Product resource ──────────────────────────────────────────────────────────

/**
 * Tiendanube Variant — child of a Product.
 * Source: tiendanube.github.io/api-documentation/resources/product — Variant object.
 */
export interface TiendanubeVariant {
  id: number;
  /** String-encoded decimal price, e.g. "25.00". */
  price: string;
  stock: number;
  sku: string;
  /** Present when a promotional price is active; null or absent otherwise. */
  promotional_price?: string | null;
}

/**
 * Tiendanube Product.
 * Source: tiendanube.github.io/api-documentation/resources/product — Product object.
 */
export interface TiendanubeProduct {
  id: number;
  name: TiendanubeLocalizedString;
  variants: TiendanubeVariant[];
}

/**
 * Bulk stock/price update entry for PATCH /products/stock-price.
 * Up to 50 variants per call.
 * Source: tiendanube.github.io/api-documentation/resources/product
 */
export interface TiendanubeBulkStockPriceEntry {
  id: number;
  price?: string;
  stock?: number;
}

// ── Customer resource ─────────────────────────────────────────────────────────

/**
 * Tiendanube Customer.
 * Source: tiendanube.github.io/api-documentation/resources/customer — Customer object.
 */
export interface TiendanubeCustomer {
  id: number;
  name: string;
  email: string | null;
  phone: string | null;
  default_address?: {
    address: string | null;
    city: string | null;
    zipcode: string | null;
  } | null;
}

// ── Order resource ────────────────────────────────────────────────────────────

/**
 * Tiendanube Order Line Item (product inside an order).
 * Source: tiendanube.github.io/api-documentation/resources/order — LineItem object.
 */
export interface TiendanubeOrderLineItem {
  variant_id: number;
  quantity: number;
  price: string;
  name: TiendanubeLocalizedString;
}

/**
 * Tiendanube Order.
 * Source: tiendanube.github.io/api-documentation/resources/order — Order object.
 */
export interface TiendanubeOrder {
  id: number;
  number: number;
  status: string;
  payment_status: string;
  gateway: string | null;
  total: string;
  subtotal: string;
  created_at: string;
  updated_at: string;
  products: TiendanubeOrderLineItem[];
  customer: {
    id: number;
    name: string;
    email: string | null;
  } | null;
}
