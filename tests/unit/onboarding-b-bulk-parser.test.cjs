// Unit tests for Fase B: bulk product parser and B2B business-type aliases.
// Follows the existing onboarding-*.test.cjs cjs pattern.

const assert = require("node:assert/strict");
const test = require("node:test");

const { parseBulkProductInput } = require(
  "../../src/app/api/business-assistant/_lib/onboarding-fast-path.bulk-parser.ts"
);

const {
  detectBusinessType,
  detectBusinessTypeChange,
} = require("../../src/app/api/business-assistant/_lib/onboarding-fast-path.parsers.ts");

// ── parseBulkProductInput ─────────────────────────────────────────────────────
// NOTE: return type changed to { products, skipped } | null (BulkParseResult).

test("bulk: parses multi-line input (newlines)", () => {
  const input = "Aceite Girasol 1L 1200\nAceite Maíz 900ml 980\nAzúcar bolsa 5kg 600";
  const result = parseBulkProductInput(input);
  assert.ok(result !== null, "should return result object");
  assert.equal(result.products.length, 3);
  assert.equal(result.skipped, 0);
  assert.equal(result.products[0].name, "Aceite Girasol 1L");
  assert.equal(result.products[0].price, 1200);
  assert.equal(result.products[1].name, "Aceite Maíz 900ml");
  assert.equal(result.products[1].price, 980);
  assert.equal(result.products[2].name, "Azúcar bolsa 5kg");
  assert.equal(result.products[2].price, 600);
});

test("bulk: parses semicolon-delimited input", () => {
  const input = "Aceite Girasol 1L 1200; Aceite Maíz 900ml 980";
  const result = parseBulkProductInput(input);
  assert.ok(result !== null);
  assert.equal(result.products.length, 2);
  assert.equal(result.skipped, 0);
});

test("bulk: parses mixed newlines and semicolons", () => {
  const input = "Producto A 100\nProducto B 200; Producto C 300";
  const result = parseBulkProductInput(input);
  assert.ok(result !== null);
  assert.equal(result.products.length, 3);
  assert.equal(result.skipped, 0);
});

test("bulk: returns null for fewer than 2 valid lines (single product)", () => {
  const input = "Alfajor 500";
  const result = parseBulkProductInput(input);
  assert.equal(result, null);
});

test("bulk: returns null for empty input", () => {
  assert.equal(parseBulkProductInput(""), null);
  assert.equal(parseBulkProductInput("   "), null);
});

test("bulk: skips invalid lines, returns valid ones if ≥2", () => {
  const input = "Aceite 1200\nEsto no tiene precio\nAzúcar 600\nFrase sin precio tampoco";
  const result = parseBulkProductInput(input);
  assert.ok(result !== null, "two valid lines should parse");
  assert.equal(result.products.length, 2);
  assert.equal(result.skipped, 2, "two invalid lines should be counted");
  assert.equal(result.products[0].name, "Aceite");
  assert.equal(result.products[1].name, "Azúcar");
});

test("bulk: returns null when all lines are invalid", () => {
  const input = "Sin precio aqui\nTampoco este\nNi este";
  const result = parseBulkProductInput(input);
  assert.equal(result, null);
});

test("bulk: caps at 50 products", () => {
  // Build 60 lines of valid products — 10 lines beyond the cap are skipped.
  const lines = Array.from({ length: 60 }, (_, i) => `Producto${i + 1} ${(i + 1) * 100}`);
  const result = parseBulkProductInput(lines.join("\n"));
  assert.ok(result !== null);
  assert.equal(result.products.length, 50);
  assert.equal(result.skipped, 10, "lines beyond the 50-product cap are skipped");
});

test("bulk: returns null when only 1 line parses (falls through to single path)", () => {
  const input = "Aceite 1200\nEsto no tiene precio";
  const result = parseBulkProductInput(input);
  assert.equal(result, null);
});

// ── Duplicate name+price idempotency seed fix (Fix 3a) ───────────────────────

test("bulk: duplicate name+price entries both appear in products array", () => {
  // Without the index-based seed fix, the second 'Aceite 1200' would silently
  // dedup to the same idempotency key and the product count would be wrong.
  // The parser itself doesn't deduplicate — it relies on the caller to use
  // distinct seeds per position. Both must appear so the caller can create
  // them with distinct seeds (idx included in seed by owner-handler.stages-onboarding.ts).
  const input = "Aceite 1200\nAceite 1200\nAzúcar 600";
  const result = parseBulkProductInput(input);
  assert.ok(result !== null);
  assert.equal(result.products.length, 3, "both duplicate entries must be present");
  assert.equal(result.skipped, 0);
  assert.equal(result.products[0].name, "Aceite");
  assert.equal(result.products[1].name, "Aceite");
  assert.equal(result.products[2].name, "Azúcar");
});

test("bulk: skipped count is 0 for a clean paste", () => {
  const input = "Producto X 100\nProducto Y 200\nProducto Z 300";
  const result = parseBulkProductInput(input);
  assert.ok(result !== null);
  assert.equal(result.skipped, 0);
});

// ── B2B business-type aliases ─────────────────────────────────────────────────

test("detectBusinessType: chip exact 'Distribuidora'", () => {
  assert.equal(detectBusinessType("Distribuidora"), "Distribuidora");
});

test("detectBusinessType: chip exact 'Mayorista'", () => {
  assert.equal(detectBusinessType("Mayorista"), "Mayorista");
});

test("detectBusinessType: chip exact 'Proveedor'", () => {
  assert.equal(detectBusinessType("Proveedor"), "Proveedor");
});

test("detectBusinessType: chip exact 'Fabricante'", () => {
  assert.equal(detectBusinessType("Fabricante"), "Fabricante");
});

test("detectBusinessType: alias 'distribuidor' → Distribuidora", () => {
  assert.equal(detectBusinessType("distribuidor"), "Distribuidora");
});

test("detectBusinessType: alias 'distribución' → Distribuidora", () => {
  assert.equal(detectBusinessType("distribución"), "Distribuidora");
});

test("detectBusinessType: alias 'mayoreo' → Mayorista", () => {
  assert.equal(detectBusinessType("mayoreo"), "Mayorista");
});

test("detectBusinessType: alias 'proveedora' → Proveedor", () => {
  assert.equal(detectBusinessType("proveedora"), "Proveedor");
});

test("detectBusinessType: alias 'fabrica' → Fabricante", () => {
  assert.equal(detectBusinessType("fabrica"), "Fabricante");
});

test("detectBusinessType: alias 'fábrica' → Fabricante", () => {
  assert.equal(detectBusinessType("fábrica"), "Fabricante");
});

test("detectBusinessType: alias 'manufactura' → Fabricante", () => {
  assert.equal(detectBusinessType("manufactura"), "Fabricante");
});

// Legacy B2C aliases must still resolve (regression guard)
test("detectBusinessType: legacy 'kiosco' still resolves to Mini-market", () => {
  assert.equal(detectBusinessType("kiosco"), "Mini-market");
});

test("detectBusinessType: legacy 'ropa' still resolves to Ropa/boutique", () => {
  assert.equal(detectBusinessType("ropa"), "Ropa/boutique");
});

test("detectBusinessType: legacy 'mascotas' still resolves to Mascotas", () => {
  assert.equal(detectBusinessType("mascotas"), "Mascotas");
});

test("detectBusinessType: legacy 'belleza' still resolves to Belleza", () => {
  assert.equal(detectBusinessType("belleza"), "Belleza");
});

// detectBusinessTypeChange with B2B types
test("detectBusinessTypeChange: chip exact 'Distribuidora' resolves directly", () => {
  // Case (b): chip re-tapped — exact alias match, no verb needed.
  const result = detectBusinessTypeChange("Distribuidora");
  assert.equal(result, "Distribuidora");
});

test("detectBusinessTypeChange: 'cambiá el tipo a mayorista' resolves", () => {
  const result = detectBusinessTypeChange("cambiá el tipo a mayorista");
  assert.equal(result, "Mayorista");
});

test("detectBusinessTypeChange: 'en realidad es fabricante' resolves", () => {
  const result = detectBusinessTypeChange("en realidad es fabricante");
  assert.equal(result, "Fabricante");
});
