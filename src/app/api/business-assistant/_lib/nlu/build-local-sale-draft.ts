// Resolves the Fast-Path-matched product+customer into a ResolvedSaleDraft
// shape (matches intent-handlers/sale.ts output). Returns null when product
// is missing or has no catalog price — the client falls back to /api/parse-sale
// in that case (legacy path).
//
// This lets the Fast Path emit a fully-resolved saleDraft without a roundtrip
// to /api/parse-sale (which depends on Vertex AI and is currently flaky).

import type { ProductInfoEntry } from "../types";

export interface LocalSaleDraft {
  customer: { id: string | null; name: string };
  taxId: string | null;
  items: Array<{
    productId: string;
    productName: string;
    quantity: number;
    unitPrice: number;
    subtotal: number;
  }>;
  total: number;
  skipped: string[];
}

export function buildLocalSaleDraft(args: {
  matchedProductId: string | null;
  matchedCustomerId: string | null;
  productInfo: ProductInfoEntry[];
  customers: Array<{ id: string; name: string }>;
  /** Quantity from NLU extraction. Defaults to 1 when not provided. */
  qty?: number;
}): LocalSaleDraft | null {
  const product = args.matchedProductId
    ? args.productInfo.find((p) => p.id === args.matchedProductId)
    : null;
  if (!product || !product.price || product.price <= 0) return null;
  const quantity = (args.qty && args.qty >= 1) ? Math.floor(args.qty) : 1;
  const unitPrice = product.price;
  const subtotal = unitPrice * quantity;
  const customer = args.matchedCustomerId
    ? args.customers.find((c) => c.id === args.matchedCustomerId)
    : null;
  return {
    customer: customer
      ? { id: customer.id, name: customer.name }
      : { id: null, name: "Consumidor Final" },
    taxId: null,
    items: [{ productId: product.id, productName: product.name, quantity, unitPrice, subtotal }],
    total: subtotal,
    skipped: [],
  };
}
