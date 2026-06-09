// Unit tests for extractCheapestPrice (shipping-quote.ts) — the A3 audit fix.
// Validates Zod-schema parsing + robust JSON extraction + positive-price guard,
// which replaced the old indexOf('{')+JSON.parse text-scraping.

"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { extractCheapestPrice, isValidPostalCode } = require("../../src/lib/shipping-quote.ts");

test("valid options → cheapest positive price", () => {
  assert.equal(extractCheapestPrice('{"options":[{"priceARS":1200},{"priceARS":900}]}'), 900);
});

test("prose prefix before JSON → robust extraction", () => {
  assert.equal(extractCheapestPrice('Cotización lista: {"options":[{"priceARS":850}]}'), 850);
});

test("zero price → null (positive-price guard)", () => {
  assert.equal(extractCheapestPrice('{"options":[{"priceARS":0}]}'), null);
});

test("services[] + price field fallback", () => {
  assert.equal(extractCheapestPrice('{"services":[{"price":700}]}'), 700);
});

test("malformed / empty / no json → null", () => {
  assert.equal(extractCheapestPrice("no hay json aca"), null);
  assert.equal(extractCheapestPrice('{"options":[]}'), null);
  assert.equal(extractCheapestPrice('{"options":[{"foo":1}]}'), null);
});

// ── A-infra fix: AR postal code (old 4-digit + new CABA CPA) ──────────────────

test("isValidPostalCode: old 4-digit CPA accepted", () => {
  assert.equal(isValidPostalCode("5500"), true);
});

test("isValidPostalCode: new CABA CPA (C1414AJO) accepted", () => {
  assert.equal(isValidPostalCode("C1414AJO"), true);
  assert.equal(isValidPostalCode("m5500abc"), true); // case-insensitive
});

test("isValidPostalCode: US ZIP (5-digit) and junk rejected", () => {
  assert.equal(isValidPostalCode("10001"), false);
  assert.equal(isValidPostalCode("123"), false);
  assert.equal(isValidPostalCode(null), false);
  assert.equal(isValidPostalCode(""), false);
});
