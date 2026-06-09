const assert = require("node:assert/strict");
const test = require("node:test");

const {
  productEditClarification,
  stockAdjustmentClarification,
  stockLoadClarification,
  buildProductStockAnswer,
  buildInventorySummaryAnswer,
} = require("../../src/app/api/business-assistant/_lib/handlers/inventory-responses.ts");

// ── productEditClarification ──────────────────────────────────────────

test("productEditClarification: missing_product asks for product name", () => {
  const r = productEditClarification("missing_product");
  assert.match(r.answer, /qué producto querés editar/i);
  assert.ok(r.inputHint);
});

test("productEditClarification: ambiguous_product asks for the specific match", () => {
  const r = productEditClarification("ambiguous_product");
  assert.match(r.answer, /varios productos parecidos/i);
});

test("productEditClarification: unsupported_field calls out stock as separate flow", () => {
  const r = productEditClarification("unsupported_field");
  // Critical business rule: stock edits MUST go through stock_load / adjust_stock,
  // not edit_product. The clarification must surface this so the user understands.
  assert.match(r.answer, /stock se maneja por la carga de stock/i);
});

test("productEditClarification: missing_field lists supported fields", () => {
  const r = productEditClarification("missing_field");
  assert.match(r.answer, /nombre.*precio.*costo.*SKU/i);
});

// ── stockAdjustmentClarification ──────────────────────────────────────

test("stockAdjustmentClarification: missing_mode asks set/sum/rest", () => {
  const r = stockAdjustmentClarification("missing_mode");
  assert.match(r.answer, /establecer, sumar o restar/i);
});

test("stockAdjustmentClarification: missing_quantity asks for exact quantity", () => {
  const r = stockAdjustmentClarification("missing_quantity");
  assert.match(r.answer, /cantidad.*ajustar.*stock/i);
});

// ── stockLoadClarification ────────────────────────────────────────────

test("stockLoadClarification: missing_item_and_quantity asks for both", () => {
  const r = stockLoadClarification("missing_item_and_quantity");
  assert.match(r.answer, /nombre.*ítem.*cantidad/i);
});

test("stockLoadClarification: missing_quantity asks only for quantity", () => {
  const r = stockLoadClarification("missing_quantity");
  assert.match(r.answer, /cantidad.*cargar stock/i);
});

// ── buildProductStockAnswer ───────────────────────────────────────────

test("buildProductStockAnswer: includes product name + numeric stock + 'unidades' label", () => {
  const product = { name: "Filtro Bosch", price: 1500, stock: 12 };
  const answer = buildProductStockAnswer(product, "es-AR");
  assert.match(answer, /Filtro Bosch/);
  assert.match(answer, /12/);
  assert.match(answer, /unidades/);
});

// ── buildInventorySummaryAnswer ───────────────────────────────────────

test("buildInventorySummaryAnswer: empty catalog returns 'sin productos cargados'", () => {
  const ctx = {
    business: { name: "Test", currency: "ARS" },
    inventorySummary: { productLines: 0, totalUnits: 0, totalValue: 0 },
    products: [],
  };
  const answer = buildInventorySummaryAnswer(ctx, "es-AR");
  assert.match(answer, /no hay productos cargados/i);
});

test("buildInventorySummaryAnswer: lists top 10 sorted by stock desc, with totals header", () => {
  const ctx = {
    business: { name: "Test", currency: "ARS" },
    inventorySummary: { productLines: 3, totalUnits: 60, totalValue: 12000 },
    products: [
      { name: "Yerba", price: 6200, stock: 5 },
      { name: "Azúcar", price: 1800, stock: 50 },
      { name: "Café", price: 4900, stock: 5 },
    ],
  };
  const answer = buildInventorySummaryAnswer(ctx, "es-AR");
  // Header includes total units + total value
  assert.match(answer, /60 unidades/);
  // Sorted by stock desc → Azúcar (50) appears before Yerba (5)
  const azucarIdx = answer.indexOf("Azúcar");
  const yerbaIdx = answer.indexOf("Yerba");
  assert.ok(azucarIdx >= 0 && yerbaIdx >= 0);
  assert.ok(azucarIdx < yerbaIdx, "expected Azúcar (50 stock) listed before Yerba (5 stock)");
});

test("buildInventorySummaryAnswer: more than 10 products → truncates with '...y N más'", () => {
  const products = Array.from({ length: 15 }, (_, i) => ({
    name: `Producto ${i + 1}`,
    price: 100,
    stock: 100 - i,
  }));
  const ctx = {
    business: { name: "Test", currency: "ARS" },
    inventorySummary: { productLines: 15, totalUnits: 1455, totalValue: 145500 },
    products,
  };
  const answer = buildInventorySummaryAnswer(ctx, "es-AR");
  assert.match(answer, /\.\.\.y 5 productos más/);
});
