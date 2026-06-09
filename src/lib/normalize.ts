// Canonical text normalizers — single source of truth.
//
// Two shapes live here:
//   1. Display-cased name normalizers (supplier, customer, generic person).
//      Trim, cap at a max length, es-AR title-case the words.
//   2. Nullable text fields — trim, cap, return null if empty.
//   3. Lookup-text normalizers (lowercase + NFD + strip accents) for
//      diacritic-insensitive matching (used by supplier resolution and
//      lookup flows).
//
// Previously scattered across ~8 files in `src/app/api/_lib/*` with
// byte-identical bodies. Consolidated here so behavior changes propagate
// in one place and divergence can't silently reappear.
//
// SINGLE SOURCE OF TRUTH for Unicode normalization:
//   normalizeForMatching() is the canonical accent/homoglyph-stripping function.
//   ALL other files MUST import and call it — never inline an NFD chain.
//
//   References:
//     MDN: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/String/normalize
//     Unicode property escapes: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Regular_expressions/Unicode_character_class_escape
//     \p{M} covers all three combining-mark blocks (Mn + Mc + Me), including
//     Combining Diacritical Marks (U+0300–U+036F), Supplement (U+1DC0–U+1DFF),
//     and Combining Half Marks (U+FE20–U+FE2F). The old hard-coded [̀-ͯ]
//     range missed the latter two blocks.

const DEFAULT_MAX_LENGTH = 500;

// Diacritic-insensitive matching — lowercase + NFD-decompose + strip
// combining marks. Used by the business-assistant module to compare
// user-typed text against catalog entries without caring about accent
// marks or casing. PREVIOUSLY named `normalizeText` in that module,
// which collided with the user-input-trimmer variants handled above.
// The rename eliminates the ambiguity.
export function normalizeForMatching(value: string): string {
  // NFKC first: collapses compatibility variants and Cyrillic/Greek homoglyphs
  // (\u0435 U+0435\u2192e, \u0430 U+0430\u2192a, \u043e U+043E\u2192o, \u0456 U+0456\u2192i) into their Latin equivalents
  // before accent stripping. NFD-then-strip alone misses those confusables \u2014
  // NFKC is the correct first pass (W3C / MDN recommendation, 2026).
  //
  // \p{M} (Unicode "Mark" category) covers all combining-mark blocks:
  //   Mn (Non-Spacing Mark)  \u2014 U+0300\u2013U+036F, U+1DC0\u2013U+1DFF
  //   Mc (Spacing Combining) \u2014 various
  //   Me (Enclosing Mark)    \u2014 various
  // This replaces the old hard-coded [\u0300-\u036f] range which only covered U+0300\u2013U+036F.
  return value
    .toLowerCase()
    .normalize("NFKC")
    .normalize("NFD")
    .replace(/\p{M}/gu, "");
}

// Generic user-input trimmer. Replaces the two private `normalizeText`
// variants that previously lived in ~8 route / validator files.
// Pass `maxLen` when the backing DB column has a length ceiling (typical
// for our string fields, 500). Omit it when the caller only wants trim.
export function normalizeInput(value: unknown, maxLen?: number): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return typeof maxLen === "number" ? trimmed.slice(0, maxLen) : trimmed;
}

// Nullable variant — trim, cap, return null for empty/non-string.
export function normalizeNullableInput(value: unknown, maxLen?: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = typeof maxLen === "number" ? value.trim().slice(0, maxLen) : value.trim();
  return trimmed.length > 0 ? trimmed : null;
}


// Particles that stay lowercase when not the first word — matches
// Argentine civic-registry convention ("Juan de la Cruz", not "Juan De
// La Cruz"). Applied to normalizePersonOrBusinessName below.
const SPANISH_NAME_PARTICLES = new Set(["de", "del", "la", "las", "los", "el"]);

// Person / business display name — lowercase, then capitalize the first
// letter of each word EXCEPT Spanish particles in non-leading position.
// Canonical version: previously had a particle-aware copy in
// `src/lib/shared-utils.ts` and two simpler "capitalize every word"
// copies in `hooks/utils.names.ts` and `parse-sale/_lib/parse-sale-matching.ts`.
// Consolidating to the particle-aware variant per user decision so
// new entries match civic-registry formatting.
export function normalizePersonOrBusinessName(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";

  return trimmed
    .toLocaleLowerCase("es-AR")
    .split(/\s+/)
    .map((word, index) => {
      if (index > 0 && SPANISH_NAME_PARTICLES.has(word)) return word;
      return word.replace(/(^|(?<=-))[a-záéíóúñü]/g, (ch) => ch.toLocaleUpperCase("es-AR"));
    })
    .join(" ");
}

// Shared capitalizer used by supplier + customer names — matches every
// word (first + post-space, post-hyphen) and uppercases the first char
// via es-AR locale casing so "ñ" / accented letters behave correctly.
function titleCaseEsAR(trimmed: string): string {
  return trimmed
    .toLocaleLowerCase("es-AR")
    .replace(/(^|[\s-])([a-záéíóúñü])/g, (_match, prefix, letter) => {
      return `${prefix}${letter.toLocaleUpperCase("es-AR")}`;
    });
}

export function normalizeSupplierName(
  value: unknown,
  maxLen: number = DEFAULT_MAX_LENGTH
): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim().slice(0, maxLen);
  if (!trimmed) return "";
  return titleCaseEsAR(trimmed);
}

export function normalizeSupplierLookupText(value: string): string {
  // Delegates to normalizeForMatching (NFKC\u2192NFD\u2192\p{M} strip\u2192lowercase).
  // Applies trim() as a thin wrapper since supplier lookups often arrive
  // with leading/trailing whitespace from form inputs.
  return normalizeForMatching(value.trim());
}

export function normalizeSupplierNullableText(
  value: unknown,
  maxLen: number = DEFAULT_MAX_LENGTH
): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().slice(0, maxLen);
  return trimmed.length > 0 ? trimmed : null;
}

export function normalizeCustomerName(
  value: unknown,
  maxLen: number = DEFAULT_MAX_LENGTH
): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim().slice(0, maxLen);
  if (!trimmed) return "";
  return titleCaseEsAR(trimmed);
}

export function normalizeCustomerNullableText(
  value: unknown,
  maxLen: number = DEFAULT_MAX_LENGTH
): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().slice(0, maxLen);
  return trimmed.length > 0 ? trimmed : null;
}
