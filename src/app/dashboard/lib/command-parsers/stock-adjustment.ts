import {
  cleanProductName,
  extractQuantity,
  resolveProductName,
  type ProductCatalogItem,
  type StockAdjustmentMode,
  type VeloraSingleCommand,
} from "./shared";

// Decrease verbs for corrective removal (audit reason: correction).
const DECREASE_VERBS_RE =
  /^(?:descontale|descontame|descontar|descont(?:a|á)|saca(?:le|me)?|bajale|sacale)\s+/;
// Decrease verbs for breakage / loss / expiry (audit reason: breakage|loss).
const BREAKAGE_VERBS_RE =
  /^(?:rompi|se\s+rompio|se\s+rompieron|rompimos|tire|tiramos|perdi|perdimos|vencio|vencieron)\s+/;
// Increase verbs (manual additions, NOT stock-load deliveries).
const INCREASE_VERBS_RE =
  /^(?:sumale|agregale|agrega(?:le|me)?|mete(?:le|me)?)\s+/;
// Set-to-exact-value verbs.
const SET_VERBS_RE =
  /^(?:ajusta(?:le|me)?|ajustar|deja(?:le|me)?|poner?|pone(?:le|me)?)\s+/;

export function detectStockAdjustment(
  normalized: string,
  products: ProductCatalogItem[]
): VeloraSingleCommand | null {
  let mode: StockAdjustmentMode | null = null;
  let reason: "breakage" | "loss" | "correction" | null = null;
  let body: string | null = null;

  let m = normalized.match(DECREASE_VERBS_RE);
  if (m) {
    mode = "decrease";
    reason = "correction";
    body = normalized.slice(m[0].length).trim();
  }
  if (!body) {
    m = normalized.match(BREAKAGE_VERBS_RE);
    if (m) {
      mode = "decrease";
      reason = /rompi|rompio|rompieron|rompimos/.test(normalized) ? "breakage" : "loss";
      body = normalized.slice(m[0].length).trim();
    }
  }
  if (!body) {
    m = normalized.match(INCREASE_VERBS_RE);
    if (m) {
      mode = "increase";
      body = normalized.slice(m[0].length).trim();
    }
  }
  if (!body) {
    m = normalized.match(SET_VERBS_RE);
    if (m) {
      mode = "set";
      body = normalized.slice(m[0].length).trim();
    }
  }
  if (!mode || !body) return null;

  if (mode === "set") {
    const setMatch = body.match(/^(.+?)\s+(?:a|en)\s+(\d+)\s*$/);
    if (!setMatch) return null;
    const productName = cleanProductName(setMatch[1].trim());
    const quantity = Number.parseInt(setMatch[2], 10);
    if (!productName || !Number.isFinite(quantity) || quantity < 0) return null;
    const productMatch = resolveProductName(productName, products);
    return {
      matched: true,
      intent: "stock_adjustment",
      data: { mode, quantity, productName, productId: productMatch?.id ?? null, reason },
    };
  }

  const { quantity, rest } = extractQuantity(body);
  const productName = cleanProductName(rest);
  if (!productName || quantity <= 0) return null;
  const productMatch = resolveProductName(productName, products);
  return {
    matched: true,
    intent: "stock_adjustment",
    data: { mode, quantity, productName, productId: productMatch?.id ?? null, reason },
  };
}
