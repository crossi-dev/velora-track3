// Bulk product import parser for the onboarding product-loading turn (Fase B).
// Parses a multi-line OR semicolon-delimited paste of "Nombre Precio" entries.
// Reuses T5_PRODUCT_RE from the single-product parser — same format, applied
// line by line. Returns null for fewer than 2 valid lines so single-product
// and LLM paths still handle those cases.
//
// Max 50 products per paste — prevents accidental oversized uploads.
// Invalid lines are silently skipped (log-quality noise, not a hard error).

import { parseT5ProductInput } from "./onboarding-fast-path.product-parser";
import type { T5ProductInput } from "./onboarding-fast-path.product-parser";

export type { T5ProductInput } from "./onboarding-fast-path.product-parser";

const BULK_MAX_PRODUCTS = 50;

export interface BulkParseResult {
  products: T5ProductInput[];
  /** Number of non-empty input lines that could not be parsed. */
  skipped: number;
}

/**
 * Parses a multi-line or semicolon-delimited product list.
 * Each line must match the same "Nombre Precio" format used in single-product
 * entry (T5_PRODUCT_RE). Lines that don't parse are skipped and counted.
 *
 * Returns a BulkParseResult with ≥2 products (up to BULK_MAX_PRODUCTS), or
 * null if fewer than 2 valid lines were found (falls through to
 * single-product / LLM paths).
 */
export function parseBulkProductInput(text: string): BulkParseResult | null {
  if (!text || !text.trim()) return null;

  // Normalise delimiters: semicolons and newlines are interchangeable.
  const rawLines = text
    .replace(/;/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const products: T5ProductInput[] = [];
  let skipped = 0;

  for (let i = 0; i < rawLines.length; i++) {
    if (products.length >= BULK_MAX_PRODUCTS) {
      // Remaining lines beyond the cap are all skipped.
      skipped += rawLines.length - i;
      break;
    }
    const parsed = parseT5ProductInput(rawLines[i]);
    if (parsed) {
      products.push(parsed);
    } else {
      skipped++;
    }
  }

  return products.length >= 2 ? { products, skipped } : null;
}
