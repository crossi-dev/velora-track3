import type {
  BulkPriceDirection,
  VeloraSingleCommand,
} from "./shared";

// Only fires on explicit bulk signals: "todos", "todo" (+ price context).
// Requires a direction verb and either a % or a peso amount. Single-product
// updates are caught by edit_product.
const DIRECTION_UP_RE = /\b(?:sub[ií]|aument[aá]|incrementa(?:r)?)\b/;
const DIRECTION_DOWN_RE = /\b(?:baj[aá]|reduc[ií]|reducir|descont[aá])\b/;
// "set" verbs: pone/poné/fijá/dejá. Only valid with absolute amount —
// "pone todos los precios a $50" means SET each price to $50, not delta.
const DIRECTION_SET_RE = /\b(?:pon[eé]|fij[aá]|dej[aá])\b/;
const BULK_TARGET_RE = /\b(?:todos?|todas?|cada\s+(?:uno|una))\b/;

export function detectBulkPriceUpdate(normalized: string): VeloraSingleCommand | null {
  const hasBulk = BULK_TARGET_RE.test(normalized);
  if (!hasBulk) return null;

  let direction: BulkPriceDirection | null = null;
  if (DIRECTION_UP_RE.test(normalized)) direction = "up";
  else if (DIRECTION_DOWN_RE.test(normalized)) direction = "down";
  else if (DIRECTION_SET_RE.test(normalized)) direction = "set";
  if (!direction) return null;

  // Percentage form: "...10%" or "10 %". Not valid with "set" direction
  // ("poné todos a 20%") because that would be interpreted as absolute later,
  // producing { mode: "absolute", amount: 20 } and bulk-overwriting every price.
  // Reject entirely when a percent token is present with "set".
  const percentMatch = normalized.match(/(\d+(?:[.,]\d+)?)\s*%/);
  if (percentMatch && direction === "set") return null;
  if (percentMatch) {
    const amount = Number.parseFloat(percentMatch[1].replace(",", "."));
    if (Number.isFinite(amount) && amount > 0) {
      return {
        matched: true,
        intent: "bulk_price_update",
        data: { mode: "percentage", direction, amount },
      };
    }
  }

  // Absolute form: "...$500" or "500 pesos".
  const absoluteMatch = normalized.match(/\$?\s*(\d+(?:[.,]\d+)?)\s*(?:pesos?)?\b/);
  if (absoluteMatch) {
    const amount = Number.parseFloat(absoluteMatch[1].replace(",", "."));
    if (Number.isFinite(amount) && amount > 0) {
      return {
        matched: true,
        intent: "bulk_price_update",
        data: { mode: "absolute", direction, amount },
      };
    }
  }

  return null;
}
