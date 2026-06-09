// Canonical es-AR word-to-number parser for the NLU layer.
//
// Audit ref: velora/audit/parsing-tanda-1/number-date-parsing
// Replaces three inconsistent local maps:
//   - nlu/word-numbers.ts STOCK_WORD_NUM_MAP (missing "par", "una mano")
//   - nlu/sale-create-fast-path.ts SPANISH_QTY (only dos-diez, missing 11+)
//   - onboarding-fast-path.parsers.ts WORD_NUMBERS + parseAmount (no k-suffix)
//
// Design: one canonical map + a composable parseSpanishNumber() that handles
// single tokens AND simple two-part compounds ("ciento cincuenta",
// "tres mil quinientos", "dos mil quinientos veinte") plus the k-suffix
// shorthand common in AR text ("20k" → 20 000).

// ── Canonical map ────────────────────────────────────────────────────────────
// Keyed in lowercase, accent-stripped (NFD + diacritic remove) form so callers
// can normalise once and look up cheaply.  Idioms ("media docena", "una mano")
// are handled BEFORE the map lookup in parseSpanishNumber().

export const WORD_TO_NUMBER_AR_ES: Readonly<Record<string, number>> = {
  // 1-20
  uno: 1, una: 1,
  dos: 2,
  tres: 3,
  cuatro: 4,
  cinco: 5,
  seis: 6,
  siete: 7,
  ocho: 8,
  nueve: 9,
  diez: 10,
  once: 11,
  doce: 12,
  trece: 13,
  catorce: 14,
  quince: 15,
  dieciseis: 16,   // NFD-stripped form of "dieciséis"
  diecisiete: 17,
  dieciocho: 18,
  diecinueve: 19,
  veinte: 20,
  veintiuno: 21,
  veintidos: 22,   // NFD-stripped "veintidós"
  veintitres: 23,  // NFD-stripped "veintitrés"
  veinticuatro: 24,
  veinticinco: 25,
  veintiseis: 26,
  veintisiete: 27,
  veintiocho: 28,
  veintinueve: 29,
  // Tens
  treinta: 30,
  cuarenta: 40,
  cincuenta: 50,
  sesenta: 60,
  setenta: 70,
  ochenta: 80,
  noventa: 90,
  // Hundreds
  cien: 100,
  ciento: 100,
  doscientos: 200,  doscientas: 200,
  trescientos: 300, trescientas: 300,
  cuatrocientos: 400, cuatrocientas: 400,
  quinientos: 500,  quinientas: 500,
  seiscientos: 600, seiscientas: 600,
  setecientos: 700, setecientas: 700,
  ochocientos: 800, ochocientas: 800,
  novecientos: 900, novecientas: 900,
  // Thousands
  mil: 1000,
  dosmil: 2000,
  tresmil: 3000,
  cuatromil: 4000,
  cincomil: 5000,
  seismil: 6000,
  sietemil: 7000,
  ochomil: 8000,
  nuevemil: 9000,
  diezmil: 10000,
  // Idioms
  par: 2,          // "un par de alfajores" → 2
  docena: 12,
  // "media docena" and "una mano" are handled inline in parseSpanishNumber
};

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Strip diacritics (NFD decompose + remove combining marks). */
function stripAccents(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

/** Normalise a word for map lookup: lowercase + accent-strip. */
function normaliseToken(s: string): string {
  return stripAccents(s.toLowerCase());
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Parse an es-AR number expression from free text.
 *
 * Handles:
 *   - Single tokens: "once" → 11, "par" → 2, "docena" → 12
 *   - Multi-word idioms: "media docena" → 6, "una mano" → 5
 *   - Two-part compounds: "ciento cincuenta" → 150,
 *       "tres mil quinientos" → 3500, "dos mil quinientos veinte" → 2520
 *   - k-suffix shorthand: "20k" → 20000, "5k" → 5000
 *
 * Returns null for unknown or unparseable input.
 *
 * Audit ref: velora/audit/parsing-tanda-1/number-date-parsing
 */
export function parseSpanishNumber(text: string): number | null {
  if (!text || typeof text !== "string") return null;
  const trimmed = text.trim();
  if (!trimmed) return null;

  // 1. k-suffix: "20k" / "5.5k" → × 1000
  const kMatch = trimmed.match(/^(\d+(?:[.,]\d+)?)\s*k\b/i);
  if (kMatch) {
    const base = parseFloat(kMatch[1].replace(",", "."));
    if (Number.isFinite(base) && base > 0) return Math.round(base * 1000);
  }

  // 2. Pure numeric token — fast path before word parsing.
  if (/^\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
  }

  const lower = normaliseToken(trimmed);

  // 3. Multi-word idioms (must be checked before single-token map).
  if (/^media\s+docena$/.test(lower)) return 6;
  if (/^una\s+mano$/.test(lower)) return 5;

  // 4. Single-token map lookup.
  const direct = WORD_TO_NUMBER_AR_ES[lower];
  if (direct !== undefined) return direct;

  // 5. Compound expressions — split on whitespace and try known patterns.
  //    Supported shapes (in order of decreasing specificity):
  //      a) "<hundreds> <tens-or-units>"      → e.g. "ciento cincuenta"
  //      b) "<N> mil <hundreds>"              → e.g. "tres mil quinientos"
  //      c) "<N> mil <hundreds> <tens>"       → e.g. "dos mil quinientos veinte"
  //      d) "<N> mil"                         → e.g. "veinte mil"
  //      e) "<N> mil <tail-word>"             → e.g. "mil trescientos"
  const tokens = lower.split(/\s+/);

  if (tokens.length === 2) {
    const [t0, t1] = tokens;
    const v0 = WORD_TO_NUMBER_AR_ES[t0];
    const v1 = WORD_TO_NUMBER_AR_ES[t1];
    if (v0 !== undefined && v1 !== undefined) {
      // "ciento cincuenta" → 150, "tres mil" → 3000, "veinte mil" → 20000
      if (t1 === "mil") return v0 * 1000;
      if (t0 === "mil") return 1000 + v1; // "mil quinientos" → 1500
      // hundreds + smaller → additive ("ciento cincuenta" = 150)
      if (v0 >= 100 && v1 < 100) return v0 + v1;
      // tens + units → additive ("treinta dos" = 32 — uncommon but valid)
      if (v0 >= 10 && v1 < 10) return v0 + v1;
    }
    // "<N> mil" where N is a compound (not in map as single token): skip — too complex.
  }

  if (tokens.length === 3) {
    const [t0, t1, t2] = tokens;
    const v1 = WORD_TO_NUMBER_AR_ES[t1];
    const v2 = WORD_TO_NUMBER_AR_ES[t2];
    if (t1 === "mil" && v1 !== undefined) {
      // "veinte mil quinientos" → 20500
      const v0 = WORD_TO_NUMBER_AR_ES[t0];
      if (v0 !== undefined && v2 !== undefined) return v0 * 1000 + v2;
    }
    if (t0 === "mil" || t1 === "mil") {
      // already covered above or unsupported shape
    }
    const v0 = WORD_TO_NUMBER_AR_ES[t0];
    if (v0 !== undefined && v2 !== undefined) {
      // "ciento cincuenta mil" → too big for current scope (skip)
    }
    // "tres mil quinientos" — t1 = "mil"
    if (t1 === "mil" && v0 !== undefined && v2 !== undefined) {
      return v0 * 1000 + v2;
    }
  }

  if (tokens.length === 4) {
    const [t0, t1, t2, t3] = tokens;
    const v0 = WORD_TO_NUMBER_AR_ES[t0];
    const v2 = WORD_TO_NUMBER_AR_ES[t2];
    const v3 = WORD_TO_NUMBER_AR_ES[t3];
    // "dos mil quinientos veinte" → 2520
    if (t1 === "mil" && v0 !== undefined && v2 !== undefined && v3 !== undefined) {
      return v0 * 1000 + v2 + v3;
    }
  }

  return null;
}
