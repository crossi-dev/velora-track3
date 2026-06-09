const assert = require("node:assert/strict");
const test = require("node:test");

const {
  looksLikeEditProductRequest,
  looksLikeStockAdjustmentRequest,
  looksLikeDeleteProductRequest,
  looksLikeStockLoadRequest,
} = require("../../src/app/api/business-assistant/_lib/handlers/inventory-detectors.ts");

// Inventory query detectors (isInventorySummaryRequest, isInventoryTopStockRequest,
// looksLikeSpecificProductPriceQuery, looksLikeSpecificProductStockQuery) were
// removed in the deterministic-layer inversion. Queries now route to Gemini.

// ── looksLikeEditProductRequest ───────────────────────────────────────

test("looksLikeEditProductRequest: 'cambiar el precio de la yerba' → true", () => {
  assert.equal(looksLikeEditProductRequest("cambiar el precio de la yerba"), true);
});

test("looksLikeEditProductRequest: 'cuánto vale la yerba' → false (it's a query, not an edit)", () => {
  assert.equal(looksLikeEditProductRequest("cuánto vale la yerba"), false);
});

// ── looksLikeStockAdjustmentRequest ───────────────────────────────────

test("looksLikeStockAdjustmentRequest: 'sumale 5 al stock de yerba' → true", () => {
  assert.equal(looksLikeStockAdjustmentRequest("sumale 5 al stock de yerba"), true);
});

test("looksLikeStockAdjustmentRequest: 'cargar stock de yerba' → false (procurement term defers to stock_load)", () => {
  assert.equal(looksLikeStockAdjustmentRequest("cargar stock de yerba"), false);
});

test("looksLikeStockAdjustmentRequest: 'cambiar el precio de la yerba a 100' → false (price edit, not stock adjustment)", () => {
  assert.equal(
    looksLikeStockAdjustmentRequest("cambiar el precio de la yerba a 100"),
    false
  );
});

// ── looksLikeDeleteProductRequest ─────────────────────────────────────

test("looksLikeDeleteProductRequest: 'eliminar el producto yerba' → true", () => {
  assert.equal(looksLikeDeleteProductRequest("eliminar el producto yerba"), true);
});

test("looksLikeDeleteProductRequest: '¿puedo eliminar el producto yerba?' → false (question form)", () => {
  assert.equal(
    looksLikeDeleteProductRequest("¿puedo eliminar el producto yerba?"),
    false
  );
});

// ── looksLikeStockLoadRequest ─────────────────────────────────────────

test("looksLikeStockLoadRequest: 'ingresar 50 unidades de yerba' → true", () => {
  assert.equal(looksLikeStockLoadRequest("ingresar 50 unidades de yerba"), true);
});

test("looksLikeStockLoadRequest: 'cuánto stock hay' → false (question form defers to stock query)", () => {
  assert.equal(looksLikeStockLoadRequest("cuánto stock hay"), false);
});

test("looksLikeStockLoadRequest: 'sumale 5 al stock' → false (adjustment takes priority)", () => {
  assert.equal(looksLikeStockLoadRequest("sumale 5 al stock"), false);
});

test("looksLikeStockLoadRequest: 'agregar nuevo cliente' → false (cliente keyword excludes stock load)", () => {
  assert.equal(looksLikeStockLoadRequest("agregar nuevo cliente"), false);
});
