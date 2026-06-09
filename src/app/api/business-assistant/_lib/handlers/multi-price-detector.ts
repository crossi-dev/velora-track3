import { normalizeForMatching } from "../shared";

interface MultiPriceEdit {
  productName: string;
  field: "price";
  value: number;
}

const BULK_TOKENS = /\b(todos?|todas?|cada\s+(?:uno|una)|cualquier)\b/;
const PERCENT_TOKENS = /\b(porcentaje|porciento|%|\d+\s*%)/;
const BULK_VERBS = /\b(subi|baja|aument[a-z]*|reduc[a-z]*|increment[a-z]*)\b/;
// Payment-link / cobro requests carry digits + commas (inline addresses, qty)
// that can look like multi-product price edits. Bail so they reach the
// Payments agent instead of being misrouted to multi_price_edit.
const PAYMENT_LINK_TOKENS = /\blink de (pago|cobro)\b/;

const MIN_DISTINCT_PRODUCTS = 2;
const MAX_REASONABLE_PRICE = 10_000_000;

// Detects multi-product specific-price statements like
// "el precio de las papas $50, las peras $40, las sandías $150".
//
// Requires ≥2 distinct catalog-matched products with explicit digit prices.
// Returns null for bulk-style phrasing (%, "todos", "subi 10") so those
// still reach the model and route to bulk_price_update.
//
// Word-number conversion (cincuenta, doscientos) is intentionally NOT
// handled yet — when that phrasing appears, detection falls through to
// model classification.
export interface MultiPriceDetectResult {
  edits: MultiPriceEdit[];
  // Chunks that had a price digit but no catalog product matched — used by
  // the executor to tell the user which names it couldn't resolve.
  unknownFragments: string[];
}

export function detectMultiProductPriceEdit(
  text: string,
  productNames: string[]
): MultiPriceEdit[] | null {
  const result = detectMultiProductPriceEditFull(text, productNames);
  if (!result) return null;
  return result.edits.length >= MIN_DISTINCT_PRODUCTS ? result.edits : null;
}

// Full variant used by the executor to report partial matches (MPE-03 pattern:
// "alfajor 900, fideos 300" where fideos is not in the catalog).
export function detectMultiProductPriceEditFull(
  text: string,
  productNames: string[]
): MultiPriceDetectResult | null {
  if (!text || productNames.length === 0) return null;

  const normalized = normalizeForMatching(text);

  if (BULK_TOKENS.test(normalized)) return null;
  if (PERCENT_TOKENS.test(normalized)) return null;
  if (BULK_VERBS.test(normalized)) return null;
  if (PAYMENT_LINK_TOKENS.test(normalized)) return null;

  const catalog = productNames
    .map((name) => ({
      original: name,
      normalized: normalizeForMatching(name),
      // First word — allows "coca" to match "coca cola"
      firstWord: normalizeForMatching(name).split(/\s+/)[0] ?? "",
    }))
    .filter((entry) => entry.normalized.length >= 3)
    .sort((a, b) => b.normalized.length - a.normalized.length);

  // IMPORTANT: split the ORIGINAL text, not the normalized text.
  // normalizeForMatching strips commas (replaces with spaces), so splitting
  // the normalized form loses separator information (e.g. "alfajor 900, fideos 300"
  // becomes "alfajor 900  fideos 300" — one chunk instead of two).
  const rawChunks = text.split(/[,;]|\s+y\s+|\s+&\s+|\.\s+/);
  const chunks = rawChunks.map((c) => normalizeForMatching(c));
  const edits: MultiPriceEdit[] = [];
  const unknownFragments: string[] = [];
  const seenProducts = new Set<string>();

  for (const chunk of chunks) {
    const priceMatch = chunk.match(/\$?\s*(\d{1,8})(?!\d)/);
    if (!priceMatch) continue;
    const price = Number.parseInt(priceMatch[1], 10);
    if (!Number.isFinite(price) || price <= 0 || price > MAX_REASONABLE_PRICE) continue;

    let matchedProduct: string | null = null;
    for (const entry of catalog) {
      // Full name match first, then first-word match for multi-word products
      // (e.g. "coca" matching "coca cola", "agua tónica" → "agua").
      if (
        chunk.includes(entry.normalized) ||
        (entry.firstWord.length >= 3 && chunk.includes(entry.firstWord))
      ) {
        matchedProduct = entry.original;
        break;
      }
    }

    if (!matchedProduct) {
      // Extract the word fragment for the unknown-product report
      const wordFragment = chunk.replace(/\$?\s*\d+.*/, "").trim();
      if (wordFragment) unknownFragments.push(wordFragment);
      continue;
    }
    if (seenProducts.has(matchedProduct)) continue;

    seenProducts.add(matchedProduct);
    edits.push({ productName: matchedProduct, field: "price", value: price });
  }

  // Need at least one resolved or unresolved price-bearing chunk to be useful
  if (edits.length === 0 && unknownFragments.length === 0) return null;
  return { edits, unknownFragments };
}
