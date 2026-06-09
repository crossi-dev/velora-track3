// Parser for Andreani API token input — onboarding T14 BYOA pending step.
// Pure — no context reads, no DB writes.
//
// A valid Andreani token is a compact, opaque string with these properties:
//   - At least 20 characters (tokens shorter than this are likely typos or
//     help phrases like "no tengo" or "¿dónde está?")
//   - No internal whitespace (tokens are single-word strings)
//   - Only alphanumeric characters plus common API token symbols: - _ . = + /
//     (covers JWT, Bearer, Base64, hex, and most vendor formats)
//
// The 20-char floor was chosen to exclude any Spanish word or phrase that
// could plausibly appear at this turn of the onboarding chat.

const TOKEN_RE = /^[\w\-.=+/]{20,}$/;

/**
 * Tries to extract an Andreani API token from free-text input.
 * Returns the trimmed token string if the shape matches, null otherwise.
 */
export function detectAndreaniToken(text: string): string | null {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (trimmed.length < 20) return null;
  // Reject multi-word input — tokens don't have spaces.
  if (/\s/.test(trimmed)) return null;
  if (!TOKEN_RE.test(trimmed)) return null;
  return trimmed;
}
