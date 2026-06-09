/**
 * parseARAmount — canonical Argentine-peso amount parser for the Velora chat layer.
 *
 * Unifies three previously divergent implementations:
 *   - sale-create-fast-path.ts  parsePrice  (was canonical)
 *   - stock-load-fast-path.ts   parsePrice  (missing one heuristic branch)
 *   - register-movement.ts      \$?\s*(\d{1,9}) (digits only, dropped "5.000" forms)
 *
 * Strategy (in order):
 *   1. Locate the first number-shaped token in the input string.
 *   2. k-suffix preprocessing ("5k" → "5000", "5.5k" → "5500").
 *   3. Separator disambiguation using Spanish-AR convention:
 *        - "."  = thousands separator
 *        - ","  = decimal separator
 *      Ambiguous single-separator "123.4" / "123,4":
 *        - single separator + ≤2 trailing digits → decimal
 *        - single "." with 3 trailing digits      → thousands  (e.g. "5.000")
 *        - single "," with 3 trailing digits      → thousands  (e.g. "5,000")
 *   4. Validates result is finite and > 0.
 *
 * @param text  Raw user input or pre-extracted token (e.g. "$5.000", "5k", "1.234,56").
 * @returns     Parsed number > 0, or null on parse failure / zero / garbage.
 */
export function parseARAmount(text: string): number | null {
  if (!text) return null;

  // --- Step 1: extract the first numeric token from the string. ---
  // Accepts: optional leading "$", then digits with optional "." / "," separators,
  // followed by optional k/K suffix.
  const tokenMatch = text.match(/\$?\s*(\d[\d.,]*(?:[kK])?)/);
  if (!tokenMatch) return null;
  const raw = tokenMatch[1].trim();
  if (!raw) return null;

  // --- Step 2: k-suffix ("5k" → 5000, "5.5k" → 5500). ---
  const kMatch = raw.match(/^(\d+(?:\.\d+)?)\s*[kK]$/);
  if (kMatch) {
    const base = Number(kMatch[1]);
    if (!Number.isFinite(base)) return null;
    const result = Math.round(base * 1000);
    return result > 0 ? result : null;
  }

  // --- Step 3: separator disambiguation. ---
  const dotCount = (raw.match(/\./g) ?? []).length;
  const commaCount = (raw.match(/,/g) ?? []).length;

  let n: number;

  if (dotCount === 0 && commaCount === 0) {
    // Plain integer — "5000"
    n = Number(raw);
  } else if (commaCount === 1 && dotCount === 0) {
    // Single comma: "800,50" (decimal) OR "5,000" (thousands).
    const afterComma = raw.slice(raw.lastIndexOf(",") + 1);
    if (afterComma.length <= 2) {
      // "800,50" → decimal
      n = Number(raw.replace(",", "."));
    } else {
      // "5,000" → thousands separator (EN-style written by some AR users)
      n = Number(raw.replace(",", ""));
    }
  } else if (dotCount === 1 && commaCount === 0) {
    // Single dot: "800.50" (decimal) OR "5.000" (thousands).
    const afterDot = raw.slice(raw.lastIndexOf(".") + 1);
    if (afterDot.length <= 2) {
      // "800.50" → decimal (JS default)
      n = Number(raw);
    } else {
      // "5.000" → thousands separator
      n = Number(raw.replace(".", ""));
    }
  } else if (dotCount >= 1 && commaCount === 1) {
    // "5.000,50" — canonical Argentine decimal format
    n = Number(raw.replace(/\./g, "").replace(",", "."));
  } else if (dotCount >= 1 && commaCount === 0) {
    // Multiple dots, no comma: "1.234.567" → thousands
    n = Number(raw.replace(/\./g, ""));
  } else {
    // Unexpected combination — strip all separators and hope for the best
    n = Number(raw.replace(/[,.]/g, ""));
  }

  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

/**
 * extractARAmount — convenience wrapper that searches the whole input string
 * for the first amount-shaped token and delegates to parseARAmount.
 *
 * Useful for callers (e.g. register-movement.ts) that receive a full
 * sentence and need to pull the amount out of it.
 *
 * @param text  Full sentence, e.g. "gasté $5.000 en luz".
 * @returns     Parsed number, or null if no numeric token is found.
 */
export function extractARAmount(text: string): number | null {
  return parseARAmount(text);
}
