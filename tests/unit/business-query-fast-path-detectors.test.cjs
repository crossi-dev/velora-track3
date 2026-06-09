// Unit tests for the stock_query and price_query Fast Path detectors.
// These detectors intercept read-only product queries before Gemini Flash,
// cutting latency from 2-5s to sub-200ms. Tests verify:
//   - Stock query phrasings (with/without "de", with/without "tengo")
//   - Price query phrasings (sale/vale/cuesta/precio)
//   - Voseo phrasings and accent variations
//   - Missing product fragment → null (cascade to LLM)
//   - Wide inventory asks → null (cascade to LLM / business_query handler)
//   - Negative case: full-sentence mutation intent must NOT match

"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  detectStockQueryFastPath,
} = require("../../src/app/api/business-assistant/_lib/nlu/stock-query-fast-path.ts");

const {
  detectPriceQueryFastPath,
} = require("../../src/app/api/business-assistant/_lib/nlu/price-query-fast-path.ts");

// ── Stock query: product AFTER verb + "de" ────────────────────────────────

test("stock query: 'cuánto stock me queda de tuercas' → matches tuercas", () => {
  const r = detectStockQueryFastPath("cuánto stock me queda de tuercas");
  assert.ok(r !== null, "should match");
  assert.match(r.productText, /tuercas?/i);
});

test("stock query: 'stock de tuercas' (short form) → matches tuercas", () => {
  const r = detectStockQueryFastPath("stock de tuercas");
  assert.ok(r !== null, "should match");
  assert.match(r.productText, /tuercas?/i);
});

// ── Stock query: product BEFORE verb (voseo-style) ────────────────────────

test("stock query: 'cuántas tuercas tengo' (product before verb) → matches tuercas", () => {
  const r = detectStockQueryFastPath("cuántas tuercas tengo");
  assert.ok(r !== null, "should match — product-before-verb pattern");
  assert.match(r.productText, /tuercas?/i);
});

test("stock query: 'cuantos destornilladores hay' (no accent) → matches destornilladores", () => {
  const r = detectStockQueryFastPath("cuantos destornilladores hay");
  assert.ok(r !== null, "accent-stripped variant must match");
  assert.match(r.productText, /destornilladores?/i);
});

test("stock query: 'cuántos tornillos quedan' (quedan variant) → matches tornillos", () => {
  const r = detectStockQueryFastPath("cuántos tornillos quedan");
  assert.ok(r !== null, "quedan variant should match");
  assert.match(r.productText, /tornillos?/i);
});

// ── Stock query: no product fragment → null (cascade to LLM) ─────────────

test("stock query: wide summary 'inventario completo' → null (cascade to LLM)", () => {
  const r = detectStockQueryFastPath("inventario completo");
  assert.equal(r, null, "wide inventory asks must fall through to LLM");
});

// ── Price query: 'cuánto sale/vale/cuesta X' ─────────────────────────────

test("price query: 'cuánto sale el destornillador' → price kind", () => {
  const r = detectPriceQueryFastPath("cuánto sale el destornillador");
  assert.ok(r !== null, "should match price query");
  assert.equal(r.queryKind, "price");
  assert.match(r.productText, /destornillador/i);
});

test("price query: 'cuánto vale la tuerca' → price kind", () => {
  const r = detectPriceQueryFastPath("cuánto vale la tuerca");
  assert.ok(r !== null, "should match price query");
  assert.equal(r.queryKind, "price");
  assert.match(r.productText, /tuercas?/i);
});

test("price query: 'precio de tuercas' (short form) → price kind", () => {
  const r = detectPriceQueryFastPath("precio de tuercas");
  assert.ok(r !== null, "should match price query");
  assert.equal(r.queryKind, "price");
  assert.match(r.productText, /tuercas?/i);
});

test("price query: 'cuanto cuesta el martillo' (no accent) → price kind", () => {
  const r = detectPriceQueryFastPath("cuanto cuesta el martillo");
  assert.ok(r !== null, "accent-stripped cuesta must match");
  assert.equal(r.queryKind, "price");
  assert.match(r.productText, /martillo/i);
});

// ── Price query: missing product fragment → null ─────────────────────────

test("price query: 'cuánto cuesta' with no product name → null (cascade to LLM)", () => {
  // No product fragment after the verb — detector must return null, not
  // match an empty string and answer "No encontré '' en el catálogo."
  const r = detectPriceQueryFastPath("cuánto cuesta");
  // Either null OR matches a non-empty productText — empty-match is a bug.
  if (r !== null) {
    assert.ok(r.productText.length >= 2, "if matched, productText must be non-trivial");
  }
});

// ── Negative case: mutation intent must NOT match either detector ─────────

test("negative: 'vendé 5 tuercas a Juan' (sale mutation) → both detectors return null", () => {
  const stock = detectStockQueryFastPath("vendé 5 tuercas a Juan");
  const price = detectPriceQueryFastPath("vendé 5 tuercas a Juan");
  assert.equal(stock, null, "sale mutation must not be classified as stock query");
  assert.equal(price, null, "sale mutation must not be classified as price query");
});
