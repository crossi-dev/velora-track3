// Core domain types — no UI, no framework dependencies

export interface Product {
  id: string;
  name: string;
  price: number;
  costPrice?: number | null;
  stock: number;
  sku?: string | null;
  reorderThreshold?: number | null;
  /** Weight in grams. Null when not set — Logística falls back to 500 g/item. */
  weightGrams?: number | null;
}

/** A denormalised row returned by stock-movement queries. */
export interface StockMovement {
  id: string;
  productId: string;
  productName: string;
  quantityBefore: number;
  quantityAfter: number;
  delta: number;
  reason: "sale" | "manual" | "import";
  referenceId: string | null;
  createdAt: string;
}

/** Convenience alias kept for callers that use the "Row" suffix. */
export type ProductRow = Product;
