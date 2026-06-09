// Parser for AFIP/ARCA CUIT input — onboarding T13 BYOA pending step.
// Pure — no context reads, no DB writes.
//
// Accepts any combination of separators (dash, space, mixed, or none):
//   "20-12345678-9"  (dashes)
//   "20 12345678 9"  (spaces)
//   "20-12345678 9"  (mixed — also valid)
//   "20123456789"    (11 raw digits, no separator)
//
// Help copy for users: "con guiones o sin separadores" (both are accepted).
//
// Returns canonical format "XX-XXXXXXXX-X" or null if the input is not
// a valid CUIT shape (length, prefix, check digit are NOT validated here
// to keep the parser loose — the owner may have a typo; validation at the
// DB write layer via parseCuit is the second gate).

// Loose CUIT regex: optional separators (dash or space) between segments.
const CUIT_RE = /^\s*(\d{2})[-\s]?(\d{8})[-\s]?(\d{1})\s*$/;

/**
 * Tries to parse a CUIT from free-text input.
 * Returns canonical "XX-XXXXXXXX-X" if the shape matches, null otherwise.
 *
 * Shape check only — does NOT validate prefix or check digit.
 */
export function detectCuit(text: string): string | null {
  if (typeof text !== "string" || text.trim().length === 0) return null;
  const m = CUIT_RE.exec(text.trim());
  if (!m) return null;
  const [, prefix, body, check] = m;
  return `${prefix}-${body}-${check}`;
}
