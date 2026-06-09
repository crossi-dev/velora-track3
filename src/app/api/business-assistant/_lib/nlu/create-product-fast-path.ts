// create-product Fast Path detector — keeps "cargar producto X Y unidades
// Z pesos" off the Gemini Pro Slow Path (~10-18s cross-region round-trip
// us-central1 ↔ southamerica-east1). Mirrors the shape of the client-side
// parser in `src/app/dashboard/lib/command-parsers/create-product.ts` but
// is intentionally a touch more permissive to catch the voice/STT variants
// the smoke harness uses ("cargar producto X N unidades P pesos cada una").
//
// Returns null if any required field can't be extracted — caller falls
// through to the LLM. Confidence-by-construction: every successful match
// requires explicit name + price + quantity (or explicit stock keyword)
// before we commit a deterministic action.
//
// Contract:
//   - Always lowercased + accent-stripped (callers may pre-normalize, but
//     we re-normalize defensively so direct callers don't have to).
//   - Returns { name, price, stock } in client-action shape.
//   - Patterns are anchored loosely (no ^/$) so leading interjections
//     ("dale, cargar producto X ...") still match.

import { normalizeForMatching } from "@/lib/normalize";

export interface CreateProductFastPathMatch {
  name: string;
  price: number;
  stock: number;
  /** Weight per unit in grams extracted from the text, or null when not mentioned. */
  weightGrams: number | null;
}

// Verbs that introduce a product-create turn. `cargar` covers the voice
// variant the smoke harness exercises; `nuevo`/`agregar`/`crear`/`dar de
// alta` cover the typing variants from the field. Excludes `subir`/`subi`
// because those collide with price-update intent ("subí el precio").
const CREATE_VERB = "(?:cargar|carga|carg[aá]me|nuevo|nueva|agregar|agrega(?:le|me)?|crear|crea|cre[aá]me|dar de alta|da de alta)";

// "cargar producto NAME N unidades P pesos [cada una]"
// "agregar producto NAME N unidades a P pesos"
const PATTERN_UNITS_PESOS = new RegExp(
  `${CREATE_VERB}\\s+(?:un\\s+|una\\s+)?(?:producto|articulo|item)\\s*(?:nuevo|nueva)?\\s*:?\\s+(.+?)\\s+(\\d{1,6})\\s*(?:unidades?|u(?:nid)?\\.?)\\s+(?:a\\s+|por\\s+|en\\s+|de\\s+|\\$\\s*)?\\$?\\s*(\\d{1,9})\\s*(?:pesos?)?(?:\\s+cada\\s+una?)?\\s*\\.?\\s*$`,
  "i",
);

// "nuevo producto NAME a P [pesos] (, tengo|stock S)?"
const PATTERN_PRICE_THEN_STOCK = new RegExp(
  `${CREATE_VERB}\\s+(?:un\\s+|una\\s+)?(?:producto|articulo|item)\\s*:?\\s+(.+?)\\s+(?:a|por|en)\\s+\\$?\\s*(\\d{1,9})\\s*(?:pesos?)?\\s*(?:[,\\s]+(?:tengo|stock|inventario|con)\\s+(\\d{1,6}))?\\s*\\.?\\s*$`,
  "i",
);

// "agregá producto NAME precio P (stock S)?"
const PATTERN_PRICE_KEYWORD = new RegExp(
  `${CREATE_VERB}\\s+(?:un\\s+|una\\s+)?(?:producto|articulo|item)\\s*:?\\s+(.+?)\\s+precio\\s+\\$?\\s*(\\d{1,9})\\s*(?:pesos?)?\\s*(?:[,\\s]+(?:tengo|stock|inventario)\\s+(\\d{1,6}))?\\s*\\.?\\s*$`,
  "i",
);

// "nuevo producto: NAME $P stock S"
const PATTERN_DOLLAR_STOCK = new RegExp(
  `${CREATE_VERB}\\s+(?:un\\s+|una\\s+)?(?:producto|articulo|item)\\s*:?\\s+(.+?)\\s+\\$\\s*(\\d{1,9})\\s+(?:stock|tengo|inventario|con)\\s+(\\d{1,6})\\s*\\.?\\s*$`,
  "i",
);

// "cargar N NAME a P [pesos] cada uno/una" — no "producto" keyword required.
// Covers the natural catalog-loading phrasing owners use in the field:
//   "cargar 5 bizcochos a 30 pesos cada uno"
//   "agregá 10 alfajores a 500 cada uno"
//   "cargá 3 facturas a $200 cada una"
// Capture groups: [1]=stock(qty), [2]=name, [3]=price.
// "cada uno/una" is REQUIRED (not optional) to avoid stealing "cargué 5 cocas a 800"
// from the stock-load fast-path — that phrase is a stock ingress, not a product create.
// The stock-load detector has a matching guard that yields on "cada uno/una".
const PATTERN_QTY_NAME_UNIT_PRICE = new RegExp(
  `${CREATE_VERB}\\s+(\\d{1,6})\\s+(.+?)\\s+(?:a|por)\\s+\\$?\\s*(\\d{1,9})\\s*(?:pesos?)?\\s+cada\\s+un[ao]\\s*\\.?\\s*$`,
  "i",
);

// Weight extractor — "pesa N gramos" / "N g" / "N gr" / "N grs" / "N gramos"
// Intentionally permissive: extracts any weight mention from the full input text.
const WEIGHT_RE = /\b(?:pesa\s+)?(\d{1,6})\s*(?:gramos?|grs?|g)\b/i;

function parseWeight(text: string): number | null {
  const m = WEIGHT_RE.exec(text);
  if (!m) return null;
  const n = Number.parseInt(m[1], 10);
  return Number.isFinite(n) && n > 0 && n <= 500_000 ? n : null;
}

interface ParsedTriple {
  name: string;
  price: number;
  stock: number | null;
}

function tryPattern(pattern: RegExp, text: string, stockGroup: 2 | 3): ParsedTriple | null {
  const m = text.match(pattern);
  if (!m) return null;
  const name = (m[1] ?? "").trim().replace(/[,.;:]+$/g, "").trim();
  const priceStr = stockGroup === 2 ? m[3] : m[2];
  const stockStr = stockGroup === 2 ? m[2] : m[3];
  const price = priceStr ? Number.parseInt(priceStr, 10) : NaN;
  const stock = stockStr ? Number.parseInt(stockStr, 10) : null;
  if (!name || name.length < 2) return null;
  if (!Number.isFinite(price) || price <= 0) return null;
  if (stock !== null && (!Number.isFinite(stock) || stock < 0)) return null;
  return { name, price, stock };
}

export function detectCreateProductFastPath(text: string): CreateProductFastPathMatch | null {
  if (!text || text.trim().length === 0) return null;
  const normalized = normalizeForMatching(text).replace(/\s+/g, " ").trim();

  // Weight is extracted from the RAW (non-normalized) text to preserve "g"/"gr"/"gramos".
  const weightGrams = parseWeight(text);

  // Order matters: most specific first.
  // PATTERN_UNITS_PESOS has stock-quantity BEFORE price (group 2 = stock).
  const unitsMatch = tryPattern(PATTERN_UNITS_PESOS, normalized, 2);
  if (unitsMatch) {
    return { name: unitsMatch.name, price: unitsMatch.price, stock: unitsMatch.stock ?? 0, weightGrams };
  }

  const dollarStockMatch = tryPattern(PATTERN_DOLLAR_STOCK, normalized, 3);
  if (dollarStockMatch) {
    return { name: dollarStockMatch.name, price: dollarStockMatch.price, stock: dollarStockMatch.stock ?? 0, weightGrams };
  }

  const priceKeywordMatch = tryPattern(PATTERN_PRICE_KEYWORD, normalized, 3);
  if (priceKeywordMatch) {
    return { name: priceKeywordMatch.name, price: priceKeywordMatch.price, stock: priceKeywordMatch.stock ?? 0, weightGrams };
  }

  const priceThenStockMatch = tryPattern(PATTERN_PRICE_THEN_STOCK, normalized, 3);
  if (priceThenStockMatch) {
    return { name: priceThenStockMatch.name, price: priceThenStockMatch.price, stock: priceThenStockMatch.stock ?? 0, weightGrams };
  }

  // PATTERN_QTY_NAME_UNIT_PRICE: groups are [1]=qty, [2]=name, [3]=price.
  // Inline parse because group order doesn't fit tryPattern's (name=m[1]) contract.
  const qnyM = normalized.match(PATTERN_QTY_NAME_UNIT_PRICE);
  if (qnyM) {
    const stock = Number.parseInt(qnyM[1] ?? "", 10);
    const name = (qnyM[2] ?? "").trim().replace(/[,.;:]+$/g, "").trim();
    const price = Number.parseInt(qnyM[3] ?? "", 10);
    if (name && name.length >= 2 && Number.isFinite(price) && price > 0 && Number.isFinite(stock) && stock >= 0) {
      return { name, price, stock, weightGrams };
    }
  }

  return null;
}
