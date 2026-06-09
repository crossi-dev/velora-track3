const assert = require("node:assert/strict");
const test = require("node:test");

const {
  detectMultiProductPriceEdit,
} = require("../../src/app/api/business-assistant/_lib/handlers/multi-price-detector.ts");

const CATALOG = ["Papas", "Peras", "Sandías", "Clavos", "Arena Gruesa"];

// ── Positive cases ───────────────────────────────────────────────────

test("detects two products with dollar prefix", () => {
  const result = detectMultiProductPriceEdit(
    "el precio de las papas $50, las peras $40",
    CATALOG
  );
  assert.deepEqual(result, [
    { productName: "Papas", field: "price", value: 50 },
    { productName: "Peras", field: "price", value: 40 },
  ]);
});

test("detects three products with 'a' connector", () => {
  const result = detectMultiProductPriceEdit(
    "papas a $50, peras a $40, sandías a $150",
    CATALOG
  );
  assert.equal(result?.length, 3);
  assert.equal(result?.[0].productName, "Papas");
  assert.equal(result?.[2].value, 150);
});

test("detects without dollar sign", () => {
  const result = detectMultiProductPriceEdit(
    "papas 50, peras 40",
    CATALOG
  );
  assert.equal(result?.length, 2);
  assert.equal(result?.[0].value, 50);
});

test("detects 'es X pesos' phrasing with digits", () => {
  const result = detectMultiProductPriceEdit(
    "el precio de las papas es 50, el precio de las peras es 40, el precio de las sandías es 150",
    CATALOG
  );
  assert.equal(result?.length, 3);
});

test("ignores products not in catalog", () => {
  const result = detectMultiProductPriceEdit(
    "papas $50, tornillos $30, peras $40",
    CATALOG
  );
  // tornillos not in catalog; papas + peras still valid
  assert.equal(result?.length, 2);
  const names = result?.map((e) => e.productName);
  assert.ok(names?.includes("Papas"));
  assert.ok(names?.includes("Peras"));
});

test("prefers longest catalog match (arena gruesa over arena)", () => {
  const catalog = ["Arena", "Arena Gruesa", "Peras"];
  const result = detectMultiProductPriceEdit(
    "arena gruesa $200, peras $40",
    catalog
  );
  assert.equal(result?.[0].productName, "Arena Gruesa");
});

test("dedupes same product mentioned twice", () => {
  const result = detectMultiProductPriceEdit(
    "papas $50, peras $40, papas $60",
    CATALOG
  );
  assert.equal(result?.length, 2);
  const papasEntries = result?.filter((e) => e.productName === "Papas");
  assert.equal(papasEntries?.length, 1);
  assert.equal(papasEntries?.[0].value, 50);
});

// ── Negative cases (fall through to model) ───────────────────────────

test("single product → null", () => {
  const result = detectMultiProductPriceEdit(
    "el precio de las papas es $50",
    CATALOG
  );
  assert.equal(result, null);
});

test("bulk percentage → null", () => {
  const result = detectMultiProductPriceEdit(
    "subí todos los precios 10%",
    CATALOG
  );
  assert.equal(result, null);
});

test("bulk verb without percent → null", () => {
  const result = detectMultiProductPriceEdit(
    "subí 500 pesos a las papas y las peras",
    CATALOG
  );
  assert.equal(result, null);
});

test("'todos' token → null", () => {
  const result = detectMultiProductPriceEdit(
    "poné todos a $50",
    CATALOG
  );
  assert.equal(result, null);
});

test("'cada uno' token → null", () => {
  const result = detectMultiProductPriceEdit(
    "las papas y las peras a $50 cada una",
    CATALOG
  );
  assert.equal(result, null);
});

test("stock load with prices → null when no multi-price pattern", () => {
  const result = detectMultiProductPriceEdit(
    "cargá 5 papas a $50",
    CATALOG
  );
  assert.equal(result, null);
});

test("inventory query → null", () => {
  const result = detectMultiProductPriceEdit(
    "cuánto vale una papa",
    CATALOG
  );
  assert.equal(result, null);
});

test("empty text → null", () => {
  assert.equal(detectMultiProductPriceEdit("", CATALOG), null);
});

test("empty catalog → null", () => {
  assert.equal(
    detectMultiProductPriceEdit("papas $50, peras $40", []),
    null
  );
});

test("word numbers → null (not supported yet)", () => {
  const result = detectMultiProductPriceEdit(
    "las papas cincuenta pesos, las peras cuarenta",
    CATALOG
  );
  assert.equal(result, null);
});

test("rejects unreasonable prices", () => {
  const result = detectMultiProductPriceEdit(
    "papas 999999999, peras $40",
    CATALOG
  );
  // papas price clamped, only 1 valid → null
  assert.equal(result, null);
});

test("accents-insensitive product match", () => {
  const result = detectMultiProductPriceEdit(
    "sandias $150, peras $40",
    CATALOG
  );
  assert.equal(result?.length, 2);
  assert.ok(result?.some((e) => e.productName === "Sandías"));
});
