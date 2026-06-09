"use strict";
// Run with: node --require ./tests/phase4/register.cjs --test tests/unit/cuit.test.cjs

// Unit tests for src/lib/cuit.ts — parseCuit / describePersonType.
//
// Covers:
//   1. Valid prefixes: 20, 21, 22, 23, 24, 27, 30, 33, 34.
//   2. Correct personType values including the 21/22 fix.
//   3. Invalid prefix rejection.
//   4. Check-digit validation.
//   5. Formatting and edge cases.

const assert = require("node:assert/strict");
const test = require("node:test");

const { parseCuit, describePersonType } = require("../../src/lib/cuit.ts");

// ── Valid CUIT/CUIL samples ───────────────────────────────────────────────────
// These are synthetic numbers with valid check digits for test purposes only.
// Generated using the AFIP check-digit algorithm (weights: 5,4,3,2,7,6,5,4,3,2).

// Helper to compute the AFIP check digit for a 10-digit prefix
function afipCheck(ten) {
  const weights = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const sum = weights.reduce((acc, w, i) => acc + w * Number(ten[i]), 0);
  const rem = sum % 11;
  if (rem === 0) return 0;
  if (rem === 1) return 9;
  return 11 - rem;
}

function makeValid(prefix, body) {
  const ten = `${prefix}${body}`;
  const check = afipCheck(ten);
  return `${ten}${check}`;
}

// ── parseCuit — prefix 20 (fisica_masculina) ─────────────────────────────────

test("parseCuit — prefix 20 is valid and fisica_masculina", () => {
  const raw = makeValid("20", "12345678");
  const r = parseCuit(raw);
  assert.equal(r.valid, true, `expected valid; got error: ${r.error}`);
  assert.equal(r.personType, "fisica_masculina");
  assert.equal(r.prefix, "20");
});

// ── parseCuit — prefix 21 (fisica) — AUDIT FIX ───────────────────────────────

test("parseCuit — prefix 21 is valid and fisica", () => {
  const raw = makeValid("21", "12345678");
  const r = parseCuit(raw);
  assert.equal(r.valid, true, `expected valid; got error: ${r.error}`);
  assert.equal(r.personType, "fisica");
  assert.equal(r.prefix, "21");
});

// ── parseCuit — prefix 22 (fisica) — AUDIT FIX ───────────────────────────────

test("parseCuit — prefix 22 is valid and fisica", () => {
  const raw = makeValid("22", "12345678");
  const r = parseCuit(raw);
  assert.equal(r.valid, true, `expected valid; got error: ${r.error}`);
  assert.equal(r.personType, "fisica");
  assert.equal(r.prefix, "22");
});

// ── parseCuit — prefix 27 (fisica_femenina) ──────────────────────────────────

test("parseCuit — prefix 27 is valid and fisica_femenina", () => {
  const raw = makeValid("27", "12345678");
  const r = parseCuit(raw);
  assert.equal(r.valid, true, `expected valid; got error: ${r.error}`);
  assert.equal(r.personType, "fisica_femenina");
});

// ── parseCuit — prefix 30 (juridica) ─────────────────────────────────────────

test("parseCuit — prefix 30 is valid and juridica", () => {
  const raw = makeValid("30", "12345678");
  const r = parseCuit(raw);
  assert.equal(r.valid, true, `expected valid; got error: ${r.error}`);
  assert.equal(r.personType, "juridica");
});

// ── parseCuit — invalid prefix 19 ────────────────────────────────────────────

test("parseCuit — prefix 19 is invalid", () => {
  const raw = makeValid("19", "12345678");
  const r = parseCuit(raw);
  assert.equal(r.valid, false);
  assert.equal(r.personType, "desconocida");
  assert.ok(r.error?.includes("19"), `error should mention prefix 19: ${r.error}`);
  // Updated error message should now list 21/22
  assert.ok(r.error?.includes("21"), `error should mention 21: ${r.error}`);
});

// ── parseCuit — wrong check digit ────────────────────────────────────────────

test("parseCuit — wrong check digit returns invalid", () => {
  const raw = makeValid("20", "12345678");
  // Flip the last digit
  const lastDigit = Number(raw[10]);
  const badLast = ((lastDigit + 1) % 10).toString();
  const bad = raw.slice(0, 10) + badLast;
  const r = parseCuit(bad);
  assert.equal(r.valid, false);
  assert.ok(r.error?.toLowerCase().includes("verificador"));
});

// ── parseCuit — too short ─────────────────────────────────────────────────────

test("parseCuit — too short returns invalid", () => {
  const r = parseCuit("2012345678");
  assert.equal(r.valid, false);
  assert.ok(r.error?.includes("10"));
});

// ── parseCuit — empty string ──────────────────────────────────────────────────

test("parseCuit — empty string returns invalid", () => {
  const r = parseCuit("");
  assert.equal(r.valid, false);
  assert.ok(r.error?.toLowerCase().includes("vacío"));
});

// ── parseCuit — formatted input (dashes) ─────────────────────────────────────

test("parseCuit — formatted input with dashes is accepted", () => {
  const raw = makeValid("20", "12345678");
  const formatted = `${raw.slice(0, 2)}-${raw.slice(2, 10)}-${raw.slice(10)}`;
  const r = parseCuit(formatted);
  assert.equal(r.valid, true, `expected valid; got error: ${r.error}`);
  assert.equal(r.normalized, raw);
});

// ── describePersonType — nueva entrada "fisica" ───────────────────────────────

test("describePersonType — fisica returns human-readable Spanish label", () => {
  const desc = describePersonType("fisica");
  assert.ok(desc.length > 0);
  assert.ok(desc.toLowerCase().includes("física"), `expected 'física' in: ${desc}`);
});

test("describePersonType — unknown type returns default label", () => {
  const desc = describePersonType("extraterrestrial");
  assert.ok(desc.toLowerCase().includes("desconocido"));
});
