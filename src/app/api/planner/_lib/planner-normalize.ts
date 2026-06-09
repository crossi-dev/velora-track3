import { normalizeForMatching } from "@/lib/normalize";

/**
 * Canonical product-name normalizer for the planner layer.
 *
 * Both planner-threshold.ts and condition-stock-rules.ts must use this
 * function so their product matching is identical. Delegates to
 * normalizeForMatching (NFKC→NFD→\p{M}→lowercase) — single source of truth
 * in src/lib/normalize.ts. Thin wrapper applies trim() for planner inputs.
 */
export function normalizeProductName(name: string): string {
  return normalizeForMatching(name.trim());
}
