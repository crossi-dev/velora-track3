"use strict";

/**
 * Unit tests for parseARAmount — canonical Argentine-peso amount parser.
 *
 * Run:
 *   node --require ./tests/phase4/register.cjs --test tests/unit/parse-ar-amount.test.cjs
 */

const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");

// ---------------------------------------------------------------------------
// Module resolution — mirrors the pattern used by all other unit tests in
// this suite (register.cjs hooks into tsconfig paths via ts-node/register).
// ---------------------------------------------------------------------------
const { parseARAmount } = require(
  path.resolve(__dirname, "../../src/lib/parse-ar-amount.ts"),
);

// ---------------------------------------------------------------------------
// Happy-path: plain integers
// ---------------------------------------------------------------------------
test("plain integer '5000'", () => assert.equal(parseARAmount("5000"), 5000));
test("plain integer with $ prefix '$5000'", () => assert.equal(parseARAmount("$5000"), 5000));
test("plain integer with $ and space '$ 5000'", () => assert.equal(parseARAmount("$ 5000"), 5000));

// ---------------------------------------------------------------------------
// Thousands separator — dot (AR standard)
// ---------------------------------------------------------------------------
test("'5.000' → 5000 (dot = thousands)", () => assert.equal(parseARAmount("5.000"), 5000));
test("'$5.000' → 5000", () => assert.equal(parseARAmount("$5.000"), 5000));
test("'1.234.567' → 1234567 (multiple dots)", () => assert.equal(parseARAmount("1.234.567"), 1234567));
test("'1.234,56' → 1234.56 (AR decimal)", () => assert.equal(parseARAmount("1.234,56"), 1234.56));
test("'5.000,50' → 5000.50", () => assert.equal(parseARAmount("5.000,50"), 5000.5));

// ---------------------------------------------------------------------------
// Decimal separator — comma
// ---------------------------------------------------------------------------
test("'800,50' → 800.5 (comma = decimal)", () => assert.equal(parseARAmount("800,50"), 800.5));
test("'1,5' → 1.5 (single digit after comma)", () => assert.equal(parseARAmount("1,5"), 1.5));

// ---------------------------------------------------------------------------
// Thousands separator — comma (EN-style, less common but seen)
// ---------------------------------------------------------------------------
test("'5,000' → 5000 (comma = thousands, 3 trailing digits)", () =>
  assert.equal(parseARAmount("5,000"), 5000));
test("'1,234,567' → plain strip fallback", () => {
  // Multiple commas — stripped
  const result = parseARAmount("1,234,567");
  assert.equal(result, 1234567);
});

// ---------------------------------------------------------------------------
// Decimal — dot (JS standard)
// ---------------------------------------------------------------------------
test("'5.5' → 5.5 (single dot, 1 trailing digit)", () => assert.equal(parseARAmount("5.5"), 5.5));
test("'800.50' → 800.5", () => assert.equal(parseARAmount("800.50"), 800.5));
test("'123.4' → 123.4 (single dot, ≤2 trailing digits = decimal)", () =>
  assert.equal(parseARAmount("123.4"), 123.4));

// ---------------------------------------------------------------------------
// k-suffix
// ---------------------------------------------------------------------------
test("'5k' → 5000", () => assert.equal(parseARAmount("5k"), 5000));
test("'5K' → 5000 (uppercase K)", () => assert.equal(parseARAmount("5K"), 5000));
test("'5.5k' → 5500", () => assert.equal(parseARAmount("5.5k"), 5500));
test("'$5k' → 5000", () => assert.equal(parseARAmount("$5k"), 5000));
test("'2.5K' → 2500", () => assert.equal(parseARAmount("2.5K"), 2500));

// ---------------------------------------------------------------------------
// Embedded in sentence (extractARAmount behavior)
// ---------------------------------------------------------------------------
test("extracts from '$5.000 pesos'", () => assert.equal(parseARAmount("$5.000 pesos"), 5000));
test("extracts from '800 pesos'", () => assert.equal(parseARAmount("800 pesos"), 800));

// ---------------------------------------------------------------------------
// Edge: $0 returns null (not a valid amount)
// ---------------------------------------------------------------------------
test("'$0' → null", () => assert.equal(parseARAmount("$0"), null));
test("'0' → null", () => assert.equal(parseARAmount("0"), null));

// ---------------------------------------------------------------------------
// Edge: garbage / non-numeric → null
// ---------------------------------------------------------------------------
test("empty string → null", () => assert.equal(parseARAmount(""), null));
test("null-like undefined coerced via empty → null", () => assert.equal(parseARAmount("abc"), null));
test("'pesos' (no digits) → null", () => assert.equal(parseARAmount("pesos"), null));
test("only $ sign → null", () => assert.equal(parseARAmount("$"), null));

// ---------------------------------------------------------------------------
// Edge: negative / sign characters
// The token regex extracts the numeric part after any non-digit prefix,
// so "-500" yields 500 (the sign is not a valid AR currency prefix).
// ---------------------------------------------------------------------------
test("'-500' → 500 (minus sign stripped, digits extracted)", () =>
  assert.equal(parseARAmount("-500"), 500));
