// src/lib/mcp/_lib/bulk-price-guard.ts — MCP guard against catalog-wipe / absurd bulk price changes.
//
// bulk_price_update driven by a ChatGPT/Cowork LLM can reprice the WHOLE catalog in one call.
// A hallucinated or misheard amount (e.g. set ALL products to ARS 1, or a +9999% increase)
// would silently corrupt every product's price with no undo path via MCP. This guard rejects
// the highest-risk shapes BEFORE the backend applies them. It does NOT replace the owner's
// intent for legitimate, bounded bulk adjustments — it only blocks the catastrophic outliers.

import { errResponse } from "./mcp-responses";

export interface BulkPriceArgs {
  amount: number;
  mode: "percent" | "fixed";
  direction: "up" | "down" | "set";
  productIds?: string[];
}

/** Max percentage change accepted for a bulk op (a +200% raise / capped). Above this is treated as a hallucination. */
export const BULK_MAX_PERCENT = 200;

/** Max absolute fixed change accepted on a WHOLE-catalog op (targeted ops by productIds are unbounded). */
export const BULK_MAX_FIXED_AMOUNT = 1_000_000;

/**
 * Returns an errResponse when the bulk price change is too dangerous to apply, else null.
 * Worst case guarded: an absolute "set" applied to the ENTIRE catalog (productIds omitted) =
 * catalog wipe. Secondary: percentage changes that would zero/negate prices or are absurdly large.
 */
export function bulkPriceGuard(args: BulkPriceArgs): ReturnType<typeof errResponse> | null {
  // 1. Whole-catalog absolute-set is the catalog-wipe vector — require explicit targets.
  if (args.direction === "set" && (!args.productIds || args.productIds.length === 0)) {
    return errResponse(
      "BULK_PRICE_GUARD",
      "Absolute price-set ('set') must target specific productIds — refusing to set one exact price on the ENTIRE catalog. " +
        "Pass productIds, or use direction 'up'/'down' for catalog-wide percentage/fixed changes.",
    );
  }

  // 2. Percentage bounds — a >=100% decrease zeros/negates prices; an absurd increase is a hallucination.
  if (args.mode === "percent") {
    if (args.direction === "down" && args.amount >= 100) {
      return errResponse(
        "BULK_PRICE_GUARD",
        "A percentage decrease of 100% or more would make prices zero or negative — rejected.",
      );
    }
    if (args.amount > BULK_MAX_PERCENT) {
      return errResponse(
        "BULK_PRICE_GUARD",
        `Percentage change above ${BULK_MAX_PERCENT}% is rejected as a safety guard. Split into smaller adjustments if this is intentional.`,
      );
    }
  }

  // 3. Whole-catalog FIXED change with an absurd amount = hallucination (a +$1M raise/cut on
  //    every product). Targeted (productIds) fixed ops are trusted — the owner named the products.
  if (
    args.mode === "fixed" &&
    (!args.productIds || args.productIds.length === 0) &&
    args.amount > BULK_MAX_FIXED_AMOUNT
  ) {
    return errResponse(
      "BULK_PRICE_GUARD",
      `A fixed bulk change above $${BULK_MAX_FIXED_AMOUNT} on the ENTIRE catalog is rejected as a safety guard. ` +
        "Target specific products with productIds, or use a smaller amount.",
    );
  }

  return null;
}
