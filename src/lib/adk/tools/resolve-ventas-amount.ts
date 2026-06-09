// Deterministic amount resolver for the call_ventas_agent tool.
//
// When the Supervisor sends a message like "Crear link de pago para María
// García, 3 filtros de aire con envío" the Payments Agent has no amountARS
// and asks the owner for the total — violating the "code calculates, LLM
// routes" contract.
//
// This module intercepts the message BEFORE it reaches the Payments Agent
// and injects the resolved amount when the message contains a recognisable
// (product, quantity) pair that maps to a catalog entry.
//
// Reuses:
//   - extractSaleEntities (battle-tested fuzzy + stem matcher against catalog)
//   - A minimal Spanish word-number map (subset of sale-create-fast-path.ts)
//
// Degradation contract: if resolution fails for ANY reason, the original
// message is returned UNCHANGED — the Payments Agent will ask, which is the
// existing acceptable fallback.

import { extractSaleEntities } from "@/app/api/business-assistant/_lib/extract-sale-entities";
import { normalizeForMatching } from "@/lib/normalize";

export interface CatalogProduct {
  id: string;
  name: string;
  price: number;
}

// Spanish cardinal words → numeric value.
// Intentionally excludes un/uno/una (usually articles in context).
const SPANISH_QTY_MAP: Readonly<Record<string, number>> = {
  dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6,
  siete: 7, ocho: 8, nueve: 9, diez: 10,
  once: 11, doce: 12, trece: 13, catorce: 14, quince: 15,
  veinte: 20, treinta: 30, cuarenta: 40, cincuenta: 50,
};

// Matches a leading digit quantity, e.g. "3 filtros". Group 1 = the number.
const DIGIT_QTY_RE = /\b(\d{1,4})\s+/;

// Matches Spanish word-number quantities, e.g. "tres filtros de aire".
const WORD_QTY_RE = new RegExp(
  `\\b(${Object.keys(SPANISH_QTY_MAP).join("|")})\\b`,
  "i",
);

/** Extracts the item quantity from a raw message string. Defaults to 1. */
function resolveQty(normalizedText: string): number {
  const digitMatch = normalizedText.match(DIGIT_QTY_RE);
  if (digitMatch) {
    const n = Number.parseInt(digitMatch[1], 10);
    if (Number.isFinite(n) && n >= 1 && n < 10_000) return n;
  }
  const wordMatch = normalizedText.match(WORD_QTY_RE);
  if (wordMatch) {
    const key = wordMatch[1].toLowerCase();
    const n = SPANISH_QTY_MAP[key];
    if (n !== undefined) return n;
  }
  return 1;
}

// Detects shipping intent in the message so the injection can be phrased
// correctly for the Payments Agent.
const SHIPPING_RE = /\b(env[ií]o|env[ií]a|despacho|con\s+env[ií]o|gastos\s+de\s+env[ií]o|shipping)\b/i;

/** Resolved product + quantity extracted from a raw message. */
export interface ResolvedProductInfo {
  productId: string;
  productName: string;
  qty: number;
  unitPrice: number;
}

/**
 * Resolves the product and quantity from `message` against `products` without
 * injecting any annotation. Returns null when the catalog match fails, the
 * result is ambiguous, the catalog is empty, or the message already carries an
 * explicit amount.
 *
 * Used by resolve-ventas-shipping.ts to embed the resolved productId directly
 * into the PAGO_CON_ENVÍO_RESUELTO annotation so the Payments Agent LLM never
 * needs to look up a productId — eliminating the hallucination vector.
 */
export function resolveProductFromMessage(
  message: string,
  products: ReadonlyArray<CatalogProduct>,
): ResolvedProductInfo | null {
  if (!message || products.length === 0) return null;
  const normalized = normalizeForMatching(message);
  const hasExplicitAmount =
    /\$\s*\d/.test(message) ||
    /\bmonto\b/i.test(message) ||
    /\bamountARS\b/.test(message) ||
    /\bpesos?\b.*\d/i.test(message) ||
    /\d.*\bpesos?\b/i.test(message);
  if (hasExplicitAmount) return null;
  const entities = extractSaleEntities(message, [...products], []);
  const product = entities.product.match;
  if (!product || entities.product.ambiguous) return null;
  if (!Number.isFinite(product.price) || product.price <= 0) return null;
  const qty = resolveQty(normalized);
  return { productId: product.id, productName: product.name, qty, unitPrice: product.price };
}

/**
 * Tries to resolve product + quantity from `message` against `products` and
 * injects a directive amount annotation into the returned string when successful.
 *
 * Returns the original message unchanged when:
 *   - products array is empty
 *   - no product matches (ambiguous or zero score)
 *   - the message already contains an explicit amount pattern ("$", "monto",
 *     "amountARS", or a bare number preceded by $ or the word "pesos")
 *
 * Injection format (shipping absent):
 *   "(BASE_PRODUCTS_ARS: $N — pasá amountARS=$N a create_payment_link)"
 *
 * Injection format (shipping present):
 *   "(BASE_PRODUCTS_ARS: $N — pasá amountARS=$N y shippingRequired:true a
 *    create_payment_link; el sistema cotiza el flete solo, NO lo preguntes)"
 *
 * Using "BASE_PRODUCTS_ARS" instead of "monto estimado" prevents the LLM from
 * reading the value as a preliminary total and asking "¿cuánto agrego por el envío?".
 * The directive is imperative, not advisory.
 */
export function injectResolvedAmount(
  message: string,
  products: ReadonlyArray<CatalogProduct>,
): string {
  if (!message || products.length === 0) return message;

  // Skip if the message already carries an explicit amount to avoid
  // overriding prices that the Supervisor consciously included.
  const normalized = normalizeForMatching(message);
  const hasExplicitAmount =
    /\$\s*\d/.test(message) ||
    /\bmonto\b/i.test(message) ||
    /\bamountARS\b/.test(message) ||
    /\bpesos?\b.*\d/i.test(message) ||
    /\d.*\bpesos?\b/i.test(message);

  if (hasExplicitAmount) return message;

  // extractSaleEntities expects mutable arrays. Spread into a fresh array so
  // the ReadonlyArray constraint is satisfied without mutating the original.
  // CatalogProduct satisfies the CatalogEntry constraint (has id + name),
  // so the generic infers P = CatalogProduct and match carries the price field.
  // Pass empty customers array — only product resolution is needed here.
  const entities = extractSaleEntities(message, [...products], []);

  const product = entities.product.match;
  if (!product || entities.product.ambiguous) return message;

  const qty = resolveQty(normalized);
  const unitPrice = product.price;
  if (!Number.isFinite(unitPrice) || unitPrice <= 0) return message;

  const totalARS = qty * unitPrice;
  const formattedTotal = totalARS.toLocaleString("es-AR");

  const hasShipping = SHIPPING_RE.test(message);
  const annotation = hasShipping
    ? `(BASE_PRODUCTS_ARS: $${formattedTotal} — pasá amountARS=${totalARS} y shippingRequired:true a create_payment_link; el sistema cotiza el flete solo, NO lo preguntes al dueño)`
    : `(BASE_PRODUCTS_ARS: $${formattedTotal} — pasá amountARS=${totalARS} a create_payment_link)`;

  return `${message} ${annotation}`;
}
