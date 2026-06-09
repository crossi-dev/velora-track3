/**
 * Pure shared money-guard primitives.
 *
 * These functions answer the question: "did the user literally type this
 * numeric value in their raw message?" They are the single source of truth
 * for user-typed amount detection used by:
 *
 *   - supervisor-action-mapper.money-guard.ts  (H-3 guard, production since fc099549)
 *   - agent-factory.seams.ts  (P1 guardMoneyAmount, generalised factory seam)
 *
 * This module is intentionally PURE — no I/O, no side effects, no app-layer
 * imports, no "server-only". Import freely from any layer.
 *
 * Algorithm history (abbreviated — full JD trace in engram jd/supervisor-h3-money-guard):
 *
 *   Round 1: regex `\b\d{2,}\b` matched quantities ("2500 alfajores") and
 *            misidentified `$` as an end-anchor → two structural bugs.
 *   Round 2: value-match via ownerNumericTokens fixed Issue 1 (false positives)
 *            but qty token still matched when LLM copied qty into price field.
 *   Round 3 (canonical): qty token explicitly excluded from the candidate pool.
 *            % suffix check added. 14/14 tests green. JD verdict: GO.
 *
 * The 0.01 tolerance constant is shared so both call sites stay in sync if
 * the tolerance is ever adjusted.
 */

/** 1 % tolerance covers floating-point noise while catching intentional mutations. */
export const PRICE_DEVIATION_TOLERANCE = 0.01;

/**
 * Extract every number the user literally wrote, normalised to a JS float.
 *
 * Handles common AR formats:
 *   "3000"      → [3000]
 *   "$3000"     → [3000]
 *   "1.500"     → [1500]  (AR thousands separator)
 *   "2.500,50"  → [2500.5]
 *
 * Numbers immediately followed by "%" are skipped — they are percentages,
 * never prices. This closes the round-2 regression where "10% descuento"
 * would yield token 10, which could match an LLM-invented price of 10.
 *
 * @param rawText - The unprocessed user message text.
 * @returns Array of finite positive floats in document order.
 */
export function ownerNumericTokens(rawText: string): number[] {
  const out: number[] = [];
  for (const m of rawText.matchAll(/\d[\d.,]*/g)) {
    // Skip percentages ("10% descuento") — a number before "%" is never a price.
    const after = rawText.slice((m.index ?? 0) + m[0].length).trimStart();
    if (after.startsWith("%")) continue;
    // AR thousands dot: "1.500" → "1500"; decimal comma: "1500,50" → "1500.50".
    const normalized = m[0].replace(/\.(?=\d{3}\b)/g, "").replace(",", ".");
    const n = Number.parseFloat(normalized);
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

/**
 * True when the user's raw text contains a number that matches `amount`
 * within PRICE_DEVIATION_TOLERANCE, after excluding the `qty` token.
 *
 * The `qty` exclusion is the key correctness property (closed in JD round 2):
 * when the LLM copies the sale quantity into the price field ("vendé 2500
 * alfajores" → unitPrice=2500), the qty token 2500 would otherwise match and
 * wrongly honour a hallucinated price. Excluding it ensures a bare quantity
 * is never treated as a stated price.
 *
 * @param rawText - The unprocessed user message text.
 * @param amount  - The numeric value to test (LLM-emitted price or amount).
 * @param qty     - The sale quantity (if known). When provided, tokens equal
 *                  to this value are excluded from the candidate pool.
 *                  Pass undefined when qty is unavailable.
 * @returns true if the user explicitly typed a value matching `amount`.
 */
export function userTypedThisAmount(
  rawText: string,
  amount: number,
  qty: number | undefined,
): boolean {
  return ownerNumericTokens(rawText)
    .filter((t) => qty === undefined || t !== qty)
    .some((t) => t > 0 && Math.abs(amount - t) / t <= PRICE_DEVIATION_TOLERANCE);
}
