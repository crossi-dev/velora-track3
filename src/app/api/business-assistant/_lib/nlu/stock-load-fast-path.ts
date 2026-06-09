// stock_load Fast Path detector — deterministic extraction for phrases like
// "llegaron 12 cocas a 800 pesos" / "entraron 30 panes a 200".
//
// Bypasses Gemini Flash (~3-5s) for a class of high-frequency employee inputs
// that carry a well-structured pattern: verb + quantity + product + optional price.
//
// Contract:
//   - Returns { intent: "stock_load", quantity, productHint, unitCost } on match.
//   - Returns null when ambiguous (quantity missing, product has no letters, etc).
//   - Digit quantities only (word-number support excluded to keep the detector
//     under 60 lines; STT on Android always emits digits for counts).
//   - Price / unitCost: optional ("a $Y" / "a Y pesos"). Null when absent.
//   - Detection is conservative — false positives on a stock load are worse
//     than missing the fast path (fall through to LLM is always safe).

import { normalizeForMatching } from "@/lib/normalize";
import { parseARAmount } from "@/lib/parse-ar-amount";

export interface StockLoadFastPathMatch {
  intent: "stock_load";
  quantity: number;
  productHint: string;
  unitCost: number | null;
}

// Verbs that introduce a stock-load event. Normalized (accent-stripped) form.
// Voseo imperatives (cargá → carga, agregá → agrega) arrive already normalized.
// `compr\w*` covers "compré"/"compro"/"comprar"/"compramos" — natural AR
// restock verb ("compré 50 birras" = stock ingress, not a sale).
// Subjunctive forms (agregues, sumes, cargues, etc.) cover "necesito que agregues…"
// `ingres[ao]\w*` covers "ingresá"/"ingresa"/"ingresamos"/"ingresaron".
const VERB_STEM_ALT =
  "llegaron|entraron|recibi(?:mos|ste|o)?|" +
  // cargar covers infinitive ("cargar"), voseo imperative ("cargá" → normalized "carga"),
  // preterite ("cargué"→"cargue", "cargamos", "cargaron") and subjunctive ("cargues").
  "carg(?:ar|ue[ns]?|o|a(?:mos|ron)?|ues?)?|" +
  "meti(?:mos|ste|o)?|" +
  "sumi(?:mos|ste|o)?|sumes?|sumar|suma(?:mos|ron)?|" +
  "agrega(?:mos|ron)?|agregues?|agregar|" +
  "meter|metes?|" +
  "pon(?:e(?:mos|r)?|es|ga(?:mos)?)?|" +
  "ingres[ao]\\w*|" +
  "compr\\w*";
const VERB_RE = new RegExp(`\\b(?:${VERB_STEM_ALT})\\b`, "i");

// Pattern A: VERB NUMBER PRODUCT (a PRICE)?
// Captures: [1] quantity digits, [2] product text, [3] optional price digits
const VERB_QTY_PRODUCT_RE = new RegExp(
  `\\b(?:${VERB_STEM_ALT})\\s+(\\d+(?:[.,]\\d+)?)\\s+(.+?)` +
  `(?:\\s+a\\s+(?:\\$\\s*)?(\\d+(?:[.,]\\d+)?)(?:\\s*(?:pesos?|peso|ars|usd|\\$))?)?\\s*$`,
  "i",
);

// Pattern B: VERB [al stock | en stock | al inventario] NUMBER PRODUCT (a PRICE)?
// Covers "agrega al stock 10 alfajor" / "sumá al stock 50 fernet"
const VERB_STOCK_QTY_PRODUCT_RE = new RegExp(
  `\\b(?:${VERB_STEM_ALT})\\s+(?:al?|en)\\s+(?:stock|inventario)\\s+(\\d+(?:[.,]\\d+)?)` +
  `\\s+(.+?)(?:\\s+a\\s+(?:\\$\\s*)?(\\d+(?:[.,]\\d+)?)(?:\\s*(?:pesos?|peso|ars|usd|\\$))?)?\\s*$`,
  "i",
);

// Pattern C1: VERB NUMBER PRODUCT al/en stock (a PRICE)?
// Covers "agrega 10 alfajor al stock"
const VERB_QTY_PRODUCT_ALSTOCK_RE = new RegExp(
  `\\b(?:${VERB_STEM_ALT})\\s+(\\d+(?:[.,]\\d+)?)\\s+(.+?)\\s+(?:al?|en)\\s+(?:stock|inventario)` +
  `(?:\\s+a\\s+(?:\\$\\s*)?(\\d+(?:[.,]\\d+)?)(?:\\s*(?:pesos?|peso|ars|usd|\\$))?)?\\s*$`,
  "i",
);

// Pattern C2: VERB NUMBER al/en stock de PRODUCT (a PRICE)?
// Covers "sumá 50 al stock de fernet" — quantity then "al stock de" then product
const VERB_QTY_ALSTOCK_DE_PRODUCT_RE = new RegExp(
  `\\b(?:${VERB_STEM_ALT})\\s+(\\d+(?:[.,]\\d+)?)\\s+(?:al?|en)\\s+(?:stock|inventario)\\s+de\\s+(.+?)` +
  `(?:\\s+a\\s+(?:\\$\\s*)?(\\d+(?:[.,]\\d+)?)(?:\\s*(?:pesos?|peso|ars|usd|\\$))?)?\\s*$`,
  "i",
);

// Pattern D: (necesito|quiero|hay que) [que] VERB NUMBER PRODUCT [al stock] (a PRICE)?
// Covers "necesito que agregues 10 unidades de alfajor al stock"
const MODAL_VERB_QTY_PRODUCT_RE = new RegExp(
  `\\b(?:necesito|quiero|hay\\s+que|tenes\\s+que)\\s+(?:que\\s+)?` +
  `(?:${VERB_STEM_ALT})\\s+(\\d+(?:[.,]\\d+)?)\\s+(.+?)` +
  `(?:\\s+(?:al?|en)\\s+(?:stock|inventario))?` +
  `(?:\\s+a\\s+(?:\\$\\s*)?(\\d+(?:[.,]\\d+)?)(?:\\s*(?:pesos?|peso|ars|usd|\\$))?)?\\s*$`,
  "i",
);

// Pattern: NUMBER PRODUCT (VERB optional) — "12 cocas llegaron"
const QTY_PRODUCT_VERB_RE =
  /^(\d+(?:[.,]\d+)?)\s+(.+?)\s+(?:llegaron|entraron|cargados?|recibidos?)\s*$/i;

// Optional container words that appear between the verb and the product name.
// "ingresa un paquete de cerveza" → container = "paquete de", product = "cerveza".
const CONTAINER_FRAGMENT =
  "(?:(?:un[ao]?|unos?)\\s+)?(?:paquetes?|cajas?|bolsas?|docenas?)\\s+(?:de\\s+)?";

// Pattern E: multi-sentence / slot-per-sentence stock-load.
// Handles inputs like: "ingresa un paquete de cerveza. seis unidades. 5000 pesos cada una"
// After sentence-flattening + word-number normalization:
//   "ingresa un paquete de cerveza 6 unidades 5000 pesos cada una"
// Capture groups: [1] product, [2] quantity, [3] optional price.
// Price can appear as "N pesos" or "N pesos cada una/uno".
const VERB_CONTAINER_PRODUCT_QTY_RE = new RegExp(
  `\\b(?:${VERB_STEM_ALT})\\s+(?:${CONTAINER_FRAGMENT})?` +
  `(.+?)\\s+(\\d+(?:[.,]\\d+)?)\\s+unidades?` +
  `(?:\\s+(?:\\$\\s*)?(\\d+(?:[.,]\\d+)?)\\s*(?:pesos?|peso|ars|usd|\\$)(?:\\s+cada\\s+una?)?)?\\s*$`,
  "i",
);

// Strip trailing noise: "pesos", "unidades", "u.", "kg", "cajas" etc.
const TRAILING_UNIT_RE = /\s+(?:pesos?|peso|unidades?|u\.?|cajas?|bolsas?|kg|gr?|litros?|lt?)$/i;
// Strip leading unit+article noise: "unidades de", "u. de", "kilos de", etc.
const LEADING_UNIT_RE = /^(?:unidades?|u\.?|cajas?|bolsas?|kg|kilos?|litros?|lt?)\s+(?:de\s+)?/i;

// Delegates to the canonical AR-amount parser.
// TODO: consolidate qty regex / SPANISH_QTY in a follow-up pass
//       (depends on word-to-number.ts being fully wired) — see engram
//       topic_key "velora/fix/parse-ar-amount-unified".
function parsePrice(raw: string | undefined): number | null {
  if (!raw) return null;
  return parseARAmount(raw);
}

function parseQty(raw: string): number | null {
  const digits = raw.replace(",", ".");
  const n = parseFloat(digits);
  return isFinite(n) && n > 0 && Number.isInteger(n) ? n : null;
}

function cleanProduct(raw: string): string {
  return raw
    .replace(TRAILING_UNIT_RE, "")
    .replace(LEADING_UNIT_RE, "")
    .replace(/^(?:el|la|los|las|un|una|unos|unas|de)\s+/i, "")
    .replace(/[,.;:?!]+$/g, "")
    .trim();
}

function tryMatch(
  m: RegExpMatchArray | null,
  unitCostGroup: number = 3,
): StockLoadFastPathMatch | null {
  if (!m) return null;
  const qty = parseQty(m[1] ?? "");
  const rawProduct = cleanProduct(m[2] ?? "");
  const unitCost = parsePrice(m[unitCostGroup]);
  if (!qty) return null;
  if (!rawProduct || rawProduct.length < 2) return null;
  if (!/[a-z]/i.test(rawProduct)) return null;
  return { intent: "stock_load", quantity: qty, productHint: rawProduct, unitCost };
}

/**
 * Pattern E has reversed group order: [1]=product, [2]=qty, [3]=price.
 * This wrapper re-maps the groups before delegating to the standard validators.
 */
function tryMatchE(m: RegExpMatchArray | null): StockLoadFastPathMatch | null {
  if (!m) return null;
  const qty = parseQty(m[2] ?? "");
  const rawProduct = cleanProduct(m[1] ?? "");
  const unitCost = parsePrice(m[3]);
  if (!qty) return null;
  if (!rawProduct || rawProduct.length < 2) return null;
  if (!/[a-z]/i.test(rawProduct)) return null;
  return { intent: "stock_load", quantity: qty, productHint: rawProduct, unitCost };
}

// Explicit sale noun — if present, the phrase is a sale intent ("cargá una
// venta de 3 alfas"), not a stock load. Bail out so sale-create fast-path
// (detect.ts label 4b) can claim it before we do (label 3a).
const SALE_NOUN_RE = /\bventa\b/;

// "cada uno/una" at the END of a single-sentence phrase signals a unit-price
// descriptor — the owner is stating a price per unit for a NEW product
// ("cargar 5 bizcochos a 30 pesos cada uno"), not loading existing inventory.
// Yield to create-product fast-path (label 3b).
// Anchored to end-of-string so it does NOT block multi-sentence stock-load
// forms ("ingresa una cerveza. 6 unidades. 5000 pesos cada una") where
// "cada una" is embedded mid-phrase, not the terminal token.
const UNIT_PRICE_EACH_RE = /\bcada\s+un[ao]\s*\.?\s*$/;

export function detectStockLoadFastPath(text: string): StockLoadFastPathMatch | null {
  if (!text || text.trim().length === 0) return null;
  // ReDoS guard: no valid stock-load command exceeds 200 chars. Bail before
  // any regex runs to eliminate quadratic backtracking on crafted inputs.
  if (text.length > 200) return null;

  const normalized = normalizeForMatching(text).replace(/\s+/g, " ").trim();

  // Quick pre-check: must contain both a digit and a verb trigger to avoid
  // wasting regex time on unrelated inputs.
  if (!/\d/.test(normalized) || !VERB_RE.test(normalized)) return null;

  // If the phrase contains the explicit sale noun "venta", it's a sale intent
  // ("cargá una venta de 3 alfas"), not a stock load. Let sale-create own it.
  if (SALE_NOUN_RE.test(normalized)) return null;

  // If the phrase ends with "cada uno/una" AND has no sentence boundaries (dots),
  // the owner is describing a unit price for a new product, not a stock ingress.
  // Yield to create-product (label 3b).
  // We skip this guard for multi-sentence forms ("5000 pesos cada una" embedded
  // mid-sentence is the stock-load Pattern E price suffix, not a create signal).
  if (UNIT_PRICE_EACH_RE.test(normalized) && !/[.!?]/.test(normalized)) return null;

  // Pattern E (multi-sentence): try FIRST when sentence boundaries are present.
  // "ingresa un paquete de cerveza. seis unidades. 5000 pesos cada una"
  // Sentence boundaries are flattened to spaces; word-numbers are already
  // converted to digits by normalizeStockWordNumbers() in detectDeterministicIntent().
  // Running before the single-sentence patterns avoids Pattern A mis-firing on
  // "ingresa un paquete de cerveza…" where "un" looks like quantity=1.
  const flattened = normalized.replace(/[.!?]+/g, " ").replace(/\s+/g, " ").trim();
  if (flattened !== normalized) {
    const mE = tryMatchE(flattened.match(VERB_CONTAINER_PRODUCT_QTY_RE));
    if (mE) return mE;
  }

  // Pattern B: VERB al/en stock NUMBER PRODUCT — "agrega al stock 10 alfajor"
  const mB = tryMatch(normalized.match(VERB_STOCK_QTY_PRODUCT_RE));
  if (mB) return mB;

  // Pattern D: modal VERB NUMBER PRODUCT [al stock] — "necesito que agregues 10..."
  const mD = tryMatch(normalized.match(MODAL_VERB_QTY_PRODUCT_RE));
  if (mD) return mD;

  // Pattern C2: VERB NUMBER al stock de PRODUCT — "sumá 50 al stock de fernet"
  const mC2 = tryMatch(normalized.match(VERB_QTY_ALSTOCK_DE_PRODUCT_RE));
  if (mC2) return mC2;

  // Pattern C1: VERB NUMBER PRODUCT al stock — "agrega 10 alfajor al stock"
  const mC1 = tryMatch(normalized.match(VERB_QTY_PRODUCT_ALSTOCK_RE));
  if (mC1) return mC1;

  // Pattern A: VERB NUMBER PRODUCT [a PRICE] — "llegaron 12 cocas a 800"
  const mA = tryMatch(normalized.match(VERB_QTY_PRODUCT_RE));
  if (mA) return mA;

  // Pattern: QTY PRODUCT VERB — "12 cocas llegaron"
  const m2 = normalized.match(QTY_PRODUCT_VERB_RE);
  if (m2) {
    const qty = parseQty(m2[1] ?? "");
    const rawProduct = cleanProduct(m2[2] ?? "");
    if (!qty) return null;
    if (!rawProduct || rawProduct.length < 2) return null;
    if (!/[a-z]/i.test(rawProduct)) return null;
    return { intent: "stock_load", quantity: qty, productHint: rawProduct, unitCost: null };
  }

  return null;
}
