// Unit tests for stock-load Fast Path detector.
// Covers: positive (digit qty with/without price, plural product names),
//         negative (ambiguous, no product, no qty, edit verbs, questions).

const assert = require("node:assert/strict");
const test = require("node:test");

const { detectStockLoadFastPath } = require(
  "../../src/app/api/business-assistant/_lib/nlu/stock-load-fast-path.ts"
);

// ── Positive cases ────────────────────────────────────────────────────────────

test("llegaron 12 cocas a 800 pesos → match with price", () => {
  const result = detectStockLoadFastPath("llegaron 12 cocas a 800 pesos");
  assert.ok(result, "should match");
  assert.equal(result.intent, "stock_load");
  assert.equal(result.quantity, 12);
  assert.equal(result.productHint, "cocas");
  assert.equal(result.unitCost, 800);
});

test("entraron 30 panes a 200 → match with price", () => {
  const result = detectStockLoadFastPath("entraron 30 panes a 200");
  assert.ok(result, "should match");
  assert.equal(result.quantity, 30);
  assert.equal(result.productHint, "panes");
  assert.equal(result.unitCost, 200);
});

test("llegaron 5 botellas de agua sin precio → unitCost is null", () => {
  const result = detectStockLoadFastPath("llegaron 5 botellas de agua");
  assert.ok(result, "should match");
  assert.equal(result.quantity, 5);
  // productHint contains the product fragment
  assert.ok(result.productHint.includes("botellas") || result.productHint.includes("agua"), `unexpected hint: ${result.productHint}`);
  assert.equal(result.unitCost, null);
});

test("cargué 50 cervezas a 350 → match with price", () => {
  const result = detectStockLoadFastPath("cargué 50 cervezas a 350");
  assert.ok(result, "should match");
  assert.equal(result.quantity, 50);
  assert.equal(result.unitCost, 350);
});

test("metí 20 medialunas a 120 → match (plural product name)", () => {
  const result = detectStockLoadFastPath("metí 20 medialunas a 120");
  assert.ok(result, "should match");
  assert.equal(result.quantity, 20);
  assert.equal(result.productHint, "medialunas");
});

test("recibí 8 cartones de leche → match no price", () => {
  const result = detectStockLoadFastPath("recibí 8 cartones de leche");
  assert.ok(result, "should match");
  assert.equal(result.quantity, 8);
  assert.equal(result.unitCost, null);
});

test("agregá 100 alfajores a 150 → match", () => {
  const result = detectStockLoadFastPath("agregá 100 alfajores a 150");
  assert.ok(result, "should match");
  assert.equal(result.quantity, 100);
  assert.equal(result.unitCost, 150);
});

test("cargar 15 gaseosas a $500 → match with $ symbol", () => {
  const result = detectStockLoadFastPath("cargar 15 gaseosas a $500");
  assert.ok(result, "should match");
  assert.equal(result.quantity, 15);
  assert.equal(result.unitCost, 500);
});

// ── Negative cases ────────────────────────────────────────────────────────────

test("¿cuánto stock tengo? → no match (question, no quantity/product)", () => {
  const result = detectStockLoadFastPath("¿cuánto stock tengo?");
  assert.equal(result, null);
});

test("llegaron → no match (verb only, no quantity or product)", () => {
  const result = detectStockLoadFastPath("llegaron");
  assert.equal(result, null);
});

test("llegaron 12 → no match (no product letters)", () => {
  const result = detectStockLoadFastPath("llegaron 12");
  assert.equal(result, null);
});

test("cambiar precio de coca a 500 → no match (price-edit verb, not stock load)", () => {
  const result = detectStockLoadFastPath("cambiar precio de coca a 500");
  assert.equal(result, null);
});

test("vendí 5 cocas → no match (sale verb, not ingress)", () => {
  const result = detectStockLoadFastPath("vendí 5 cocas");
  assert.equal(result, null);
});
