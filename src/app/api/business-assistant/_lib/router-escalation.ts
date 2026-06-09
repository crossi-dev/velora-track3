/**
 * router-escalation.ts — escalation-gate helpers for the LLM router.
 *
 * Extracts the "should this inventory query escalate Flash→Pro?" decision so
 * it can be tested in isolation and kept out of the stage runner.
 *
 * Tightening rationale (2026-05-11):
 *   INVENTORY_WIDE_PATTERNS includes `/\binventario(?:\s+completo)?\b/` which
 *   matches the bare word "inventario" — causing product-scoped queries like
 *   "¿cuánto inventario tengo de zapatillas?" to escalate unnecessarily.
 *   Simple stock/price queries for a single product are fully handled by Flash
 *   (the Fast Path or the model stage). Only wide/full-catalog inventory
 *   queries genuinely need Pro.
 */

import { INVENTORY_WIDE_PATTERNS } from "./intent-handlers/business-query";
import { normalizeForMatching } from "./shared";
import type { ProductInfoEntry } from "./types";

/**
 * Returns true only when the text is a wide/full-catalog inventory query AND
 * there is no evidence that the user is asking about a specific product.
 *
 * A query is considered product-scoped when it contains a product name from
 * the catalog — in that case Flash already has the data and escalation is
 * wasteful.
 */
export function isWideInventoryEscalation(
  text: string,
  productInfoDirectory: ReadonlyArray<Pick<ProductInfoEntry, "name">>,
): boolean {
  const normalized = normalizeForMatching(text);

  // Must match at least one wide-inventory pattern.
  if (!INVENTORY_WIDE_PATTERNS.some((re) => re.test(normalized))) return false;

  // If the query names a specific product, Flash can answer it directly.
  if (productInfoDirectory.length > 0) {
    const normProducts = productInfoDirectory.map((p) =>
      normalizeForMatching(p.name),
    );
    if (normProducts.some((pn) => pn.length >= 3 && normalized.includes(pn))) {
      return false;
    }
  }

  return true;
}
