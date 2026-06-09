// Payment link breakdown extractor.
//
// Builds a structured PaymentLinkBreakdown from a free-text message and catalog,
// used by the payment link answer card to show itemised cost to the owner.
//
// Kept as a separate module so resolve-ventas-shipping.ts stays under the
// 300-line area limit.

import { extractSaleEntities } from "@/app/api/business-assistant/_lib/extract-sale-entities";
import type { CatalogProduct } from "./resolve-ventas-amount";

export interface BreakdownItem {
  name: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
}

/** Structured cost breakdown for the payment link answer card. */
export interface PaymentLinkBreakdown {
  items: BreakdownItem[];
  shippingCost?: number;
  shippingCourier?: string;
  total: number;
}

// Spanish cardinal words → numeric value (mirrors resolve-ventas-amount.ts).
const SPANISH_QTY_MAP: Readonly<Record<string, number>> = {
  dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6,
  siete: 7, ocho: 8, nueve: 9, diez: 10,
  once: 11, doce: 12, trece: 13, catorce: 14, quince: 15,
  veinte: 20, treinta: 30, cuarenta: 40, cincuenta: 50,
};
const DIGIT_QTY_RE = /\b(\d{1,4})\s+/;
const WORD_QTY_RE = new RegExp(`\\b(${Object.keys(SPANISH_QTY_MAP).join("|")})\\b`, "i");

function resolveQtyLocal(text: string): number {
  const d = text.match(DIGIT_QTY_RE);
  if (d) { const n = parseInt(d[1], 10); if (Number.isFinite(n) && n >= 1) return n; }
  const w = text.match(WORD_QTY_RE);
  if (w) { const n = SPANISH_QTY_MAP[w[1].toLowerCase()]; if (n !== undefined) return n; }
  return 1;
}

/**
 * Extracts a PaymentLinkBreakdown from the raw message using the catalog.
 * Returns null when no product match is found (ambiguous or no catalog).
 */
export function extractBreakdown(
  message: string,
  products: ReadonlyArray<CatalogProduct>,
  shippingCost?: number,
  shippingCourier?: string,
): PaymentLinkBreakdown | null {
  if (products.length === 0) return null;
  const entities = extractSaleEntities(message, [...products], []);
  const product = entities.product.match;
  if (!product || entities.product.ambiguous) return null;

  const qty = resolveQtyLocal(message);
  const unitPrice = product.price;
  if (!Number.isFinite(unitPrice) || unitPrice <= 0) return null;

  const lineTotal = qty * unitPrice;
  const total = shippingCost !== undefined ? lineTotal + shippingCost : lineTotal;

  return {
    items: [{ name: product.name, quantity: qty, unitPrice, lineTotal }],
    ...(shippingCost !== undefined ? { shippingCost, shippingCourier } : {}),
    total,
  };
}
