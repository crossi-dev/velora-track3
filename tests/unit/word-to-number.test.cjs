// Unit tests for @/lib/word-to-number (canonical es-AR number parser).
// Audit ref: velora/audit/parsing-tanda-1/number-date-parsing
//
// Covers the production bugs found in TANDA 1:
//   - "once" → 1 (was broken in sale-create-fast-path: SPANISH_QTY only had dos-diez)
//   - "par"  → 2 (was missing everywhere)
//   - "media docena" → 6 (was only in word-numbers.ts, not sale or onboarding)
//   - "20k"  → 20000 (was missing everywhere)
//   - compounds: "ciento cincuenta" → 150, "tres mil quinientos" → 3500
//   - "dos mil quinientos veinte" → 2520
//   - unknown token → null

const assert = require("node:assert/strict");
const test = require("node:test");

const { parseSpanishNumber, WORD_TO_NUMBER_AR_ES } = require("../../src/lib/word-to-number.ts");

// ── Single-token: previously broken (TANDA 1 regressions) ──────────────────

test("once → 11 (was returning 1 in sale-create fast-path)", () => {
  assert.equal(parseSpanishNumber("once"), 11);
});

test("par → 2 (missing from all three maps)", () => {
  assert.equal(parseSpanishNumber("par"), 2);
});

// ── Multi-word idioms ────────────────────────────────────────────────────────

test("media docena → 6", () => {
  assert.equal(parseSpanishNumber("media docena"), 6);
});

test("media docena (mixed case) → 6", () => {
  assert.equal(parseSpanishNumber("Media Docena"), 6);
});

test("una mano → 5", () => {
  assert.equal(parseSpanishNumber("una mano"), 5);
});

// ── k-suffix: previously missing everywhere ──────────────────────────────────

test("20k → 20000", () => {
  assert.equal(parseSpanishNumber("20k"), 20000);
});

test("5k → 5000", () => {
  assert.equal(parseSpanishNumber("5k"), 5000);
});

test("1.5k → 1500", () => {
  assert.equal(parseSpanishNumber("1.5k"), 1500);
});

test("20K (uppercase) → 20000", () => {
  assert.equal(parseSpanishNumber("20K"), 20000);
});

// ── Compound expressions ─────────────────────────────────────────────────────

test("ciento cincuenta → 150", () => {
  assert.equal(parseSpanishNumber("ciento cincuenta"), 150);
});

test("tres mil quinientos → 3500", () => {
  assert.equal(parseSpanishNumber("tres mil quinientos"), 3500);
});

test("dos mil quinientos veinte → 2520", () => {
  assert.equal(parseSpanishNumber("dos mil quinientos veinte"), 2520);
});

test("veinte mil → 20000", () => {
  assert.equal(parseSpanishNumber("veinte mil"), 20000);
});

test("mil quinientos → 1500", () => {
  assert.equal(parseSpanishNumber("mil quinientos"), 1500);
});

// ── Unknown / invalid → null ─────────────────────────────────────────────────

test("xyz → null", () => {
  assert.equal(parseSpanishNumber("xyz"), null);
});

test("empty string → null", () => {
  assert.equal(parseSpanishNumber(""), null);
});

test("null-ish input → null", () => {
  // @ts-ignore — deliberate runtime bad input test
  assert.equal(parseSpanishNumber(null), null);
});

// ── Spot-checks for the full coverage range ──────────────────────────────────

test("dos → 2", () => {
  assert.equal(parseSpanishNumber("dos"), 2);
});

test("diez → 10", () => {
  assert.equal(parseSpanishNumber("diez"), 10);
});

test("doce → 12", () => {
  assert.equal(parseSpanishNumber("doce"), 12);
});

test("veinte → 20", () => {
  assert.equal(parseSpanishNumber("veinte"), 20);
});

test("cien → 100", () => {
  assert.equal(parseSpanishNumber("cien"), 100);
});

test("mil → 1000", () => {
  assert.equal(parseSpanishNumber("mil"), 1000);
});

test("docena → 12", () => {
  assert.equal(parseSpanishNumber("docena"), 12);
});

// ── WORD_TO_NUMBER_AR_ES export sanity ───────────────────────────────────────

test("WORD_TO_NUMBER_AR_ES is a non-empty object", () => {
  assert.ok(typeof WORD_TO_NUMBER_AR_ES === "object");
  assert.ok(Object.keys(WORD_TO_NUMBER_AR_ES).length > 0);
});

test("WORD_TO_NUMBER_AR_ES[once] === 11", () => {
  assert.equal(WORD_TO_NUMBER_AR_ES["once"], 11);
});
