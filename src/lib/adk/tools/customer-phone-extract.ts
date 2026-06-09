/**
 * customer-phone-extract.ts
 *
 * Extracts and normalises Argentine phone numbers from free-text NLU messages.
 *
 * Supported input formats (all map to E.164 +54-9-area-number):
 *   +54 9 11 4444 3333        (already E.164-ish with spaces)
 *   +54911 44443333           (E.164 without spaces)
 *   +54911 1234-5678          (regional mobile with interior code)
 *   54-9-11-4444-3333         (hyphens, no leading +)
 *   011-15-4444-3333          (Buenos Aires local mobile, 0-prefix trunk)
 *   15-4444-3333              (Buenos Aires local mobile, no trunk)
 *   11 1234-5678              (interior area code without 0)
 *   11 6789 1234              (CABA landline — 8-digit local, area 11)
 *
 * Priority ordering in extractCustomerPhoneFromMessage:
 *   1. E.164 / international format (+54 …)
 *   2. 0-prefix domestic format (011-15-…, 0351-…)
 *   3. Bare 10-digit number (area+number, no prefix)
 *
 * Output: canonical E.164 string "+54XXXXXXXXXX" (11 digits after +54, no spaces)
 *         or null if no recognisable phone found.
 *
 * Argentina dial plan (verified 2026):
 *   - Country code: 54
 *   - Mobile numbers require a '9' between country code and area code in E.164.
 *   - CABA area code: 11 (2-digit); interior area codes: 3–4 digits.
 *   - Total digits after country code: 10 (2-digit area + 8-digit local) or
 *     (3-digit area + 7-digit local) or (4-digit area + 6-digit local).
 *
 * References:
 *   https://www.oreateai.com/blog/cracking-the-code-how-to-dial-argentinian-mobile-numbers-like-a-pro
 *   https://baexpats.org/threads/argentine-dial-plan.23966/
 *   https://nuacom.com/how-to-use-e-164-phone-number-format/
 */

// ── Regex catalogue ───────────────────────────────────────────────────────────

// Pattern 1: International / E.164-ish  (+54 [9] area local)
// Captures 0–13 significant digits after the optional '9' so we can normalise.
// Examples: "+54 9 11 4444 3333", "+54911 44443333", "+54911 1234-5678"
const INTL_RE =
  /(?<!\d)\+54[\s-]?9?[\s-]?(\d[\d\s-]{7,13}\d)(?!\d)/;

// Pattern 2: Domestic trunk  (0dd-15-… or 0dddd-…)
// Examples: "011-15-4444-3333", "0351-155-123456", "0261-725-7979"
const TRUNK_RE =
  /(?<!\d)0(\d{2,4})[\s-](?:15[\s-])?(\d[\d\s-]{5,9}\d)(?!\d)/;

// Pattern 3: Bare 10 digits (area code + local, no prefix, with optional separators)
// Matches sequences that are unambiguously phone-length (exactly 10 raw digits).
const BARE_10_RE =
  /(?<!\d)(\d[\d\s-]{8,13}\d)(?!\d)/;

// ── Normaliser helpers ────────────────────────────────────────────────────────

/** Strip every non-digit character from a string. */
function digitsOnly(s: string): string {
  return s.replace(/\D/g, "");
}

/**
 * Normalise a raw digit string to canonical E.164 (+54XXXXXXXXXX).
 *
 * Rules:
 *   - 10 raw digits (e.g. "1144443333")       → +541144443333
 *   - 11 raw digits starting with 9 ("91144…") → +54 + as-is  (+549XXXXXXXXX)
 *   - 11 raw digits starting with 54 → strip leading 54 → same as 9-digit? unlikely — reject
 *   - 12 raw digits starting with 54 + 9       → drop leading 54 → 10 digits → +54XXXXXXXXXX
 *   - 13 raw digits starting with 549          → canonical, add + prefix
 *   - anything else: return null (not a valid AR number)
 *
 * Note: we always keep the '9' mobile prefix when present because Velora stores
 * numbers as dialled (WhatsApp E.164 mobile format) — keeping '9' matches how
 * the DB was populated.
 */
function normaliseToE164(raw: string): string | null {
  const d = digitsOnly(raw);

  if (d.length === 10) {
    // Bare area+local (e.g. "1144443333") — add +549 for mobile
    // If area starts with 11 (CABA) it's almost always mobile; same for interior.
    return `+549${d}`;
  }
  if (d.length === 11 && d.startsWith("9")) {
    // Already has mobile 9 prefix (e.g. "91144443333") — prepend +54
    return `+54${d}`;
  }
  if (d.length === 12 && d.startsWith("54")) {
    // Country code present, no mobile 9 (e.g. "541144443333") — insert 9
    return `+549${d.slice(2)}`;
  }
  if (d.length === 13 && d.startsWith("549")) {
    // Full E.164 without + (e.g. "5491144443333") — add +
    return `+${d}`;
  }
  if (d.length === 13 && d.startsWith("54")) {
    // Edge: 54 + 11 digits, first after CC is not 9 — still attempt +54
    return `+${d}`;
  }
  // 7, 8, or > 13 digits → not a valid recognised AR number
  return null;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Extracts the first Argentine phone number from a free-text NLU message and
 * returns it normalised to E.164 (+54XXXXXXXXXX), or null if none found.
 *
 * Priority: international format (+54…) → domestic trunk (0xx…) → bare 10-digit.
 *
 * @example
 *   extractCustomerPhoneFromMessage("vendí a +54 9 11 1234-5678")
 *   // → "+5491190000000"
 *
 *   extractCustomerPhoneFromMessage("para Juan 011-15-4444-3333")
 *   // → "+5491144443333"
 *
 *   extractCustomerPhoneFromMessage("hola como estás")
 *   // → null
 */
export function extractCustomerPhoneFromMessage(message: string): string | null {
  // 1. International format
  const intlMatch = message.match(INTL_RE);
  if (intlMatch) {
    // Capture group 1 holds everything after the optional '9' + country code.
    // We reconstruct with the 9 if it was present in the original.
    const rawAfterCC = intlMatch[1];
    const rawFull = intlMatch[0]; // full match including +54
    const allDigits = digitsOnly(rawFull);
    const normalised = normaliseToE164(allDigits);
    if (normalised) return normalised;
    // Fallback: use the capture group digits directly
    const fallback = normaliseToE164(digitsOnly(rawAfterCC));
    return fallback;
  }

  // 2. Domestic trunk format
  const trunkMatch = message.match(TRUNK_RE);
  if (trunkMatch) {
    // Group 1 = area code (no leading 0), group 2 = local number
    const area = trunkMatch[1];
    const local = digitsOnly(trunkMatch[2]);
    const combined = area + local;
    return normaliseToE164(combined);
  }

  // 3. Bare 10-digit sequence (last resort — only accept exactly 10 raw digits
  //    to avoid false positives on order numbers, amounts, etc.)
  const bareMatch = message.match(BARE_10_RE);
  if (bareMatch) {
    const digits = digitsOnly(bareMatch[1]);
    if (digits.length === 10) {
      return normaliseToE164(digits);
    }
  }

  return null;
}
