const assert = require("node:assert/strict");
const test = require("node:test");

const {
  looksLikePriceUpdateIntent,
} = require("../../src/app/api/business-assistant/_lib/handlers/price-intent-detector.ts");

// ── Positive: price intent detected ──────────────────────────────────

test("STT-mangled multi-price statement", () => {
  assert.equal(
    looksLikePriceUpdateIntent(
      "al precio de las papas $50 el precio de la espera es $40 de personas Al Día 150"
    ),
    true
  );
});

test("standard multi-price statement", () => {
  assert.equal(
    looksLikePriceUpdateIntent("el precio de las papas $50 y las peras $40"),
    true
  );
});

test("abbreviated multi-price", () => {
  assert.equal(
    looksLikePriceUpdateIntent("precio papas 50, precio peras 40"),
    true
  );
});

// ── Negative: NOT price intent ───────────────────────────────────────

test("stock load with prices → false (cargar verb)", () => {
  assert.equal(
    looksLikePriceUpdateIntent("cargá 5 papas a $50 y 3 peras a $40"),
    false
  );
});

test("stock load with 'me llegaron' → false", () => {
  assert.equal(
    looksLikePriceUpdateIntent("me llegaron 50 clavos a 30 pesos y 20 a 40"),
    false
  );
});

test("bulk percentage update → false", () => {
  assert.equal(
    looksLikePriceUpdateIntent("subí todos los precios 10%"),
    false
  );
});

test("bulk 'todos' → false", () => {
  assert.equal(
    looksLikePriceUpdateIntent("poné todos los precios en 500"),
    false
  );
});

test("single price statement → false (needs ≥2 prices)", () => {
  assert.equal(
    looksLikePriceUpdateIntent("el precio de las papas es $50"),
    false
  );
});

test("no 'precio' word → false", () => {
  assert.equal(
    looksLikePriceUpdateIntent("las papas $50, las peras $40"),
    false
  );
});

test("empty text → false", () => {
  assert.equal(looksLikePriceUpdateIntent(""), false);
});

test("price query (consulta) → false (no multiple prices)", () => {
  assert.equal(
    looksLikePriceUpdateIntent("cuánto es el precio de las papas"),
    false
  );
});
