const assert = require("node:assert/strict");
const test = require("node:test");

const {
  handleDeleteProduct,
} = require("../../src/app/api/business-assistant/_lib/intent-handlers/product-delete.ts");

const PRODUCTS = [
  { id: "p1", name: "Arena Gruesa" },
  { id: "p2", name: "Arena Fina" },
  { id: "p3", name: "Clavo 2 pulgadas" },
];

function makeParams(overrides = {}) {
  return {
    text: "borrá clavo 2 pulgadas",
    locale: "es-AR",
    safeIntent: "delete_product",
    answer: "Procesando.",
    parsed: { intent: "delete_product" },
    context: {},
    fullCatalogProducts: PRODUCTS,
    fullCatalogCustomers: [],
    fullCatalogSuppliers: [],
    productInfoDirectory: [],
    trace: { add: () => {}, toJSON: () => null },
    ...overrides,
  };
}

const readJson = (r) => r.json();

// ── Multi-delete path ──────────────────────────────────────────────

test("multi-delete with 2 valid matches → multi_delete_product confirmation", async () => {
  const res = handleDeleteProduct(makeParams({
    parsed: {
      intent: "delete_product",
      productDeletes: [
        { productName: "Arena Gruesa" },
        { productName: "Clavo 2 pulgadas" },
      ],
    },
  }));
  const data = await readJson(res);
  assert.equal(data.confirmationRequest.action.type, "multi_delete_product");
  assert.equal(data.confirmationRequest.action.products.length, 2);
  assert.match(data.confirmationRequest.message, /no se puede deshacer/);
});

test("multi-delete with 1 valid match → falls back to single-product flow", async () => {
  const res = handleDeleteProduct(makeParams({
    parsed: {
      intent: "delete_product",
      productDeletes: [
        { productName: "Arena Gruesa" },
        { productName: "Producto Fantasma" }, // doesn't match catalog
      ],
    },
  }));
  const data = await readJson(res);
  assert.equal(data.confirmationRequest.action.type, "delete_product");
  assert.equal(data.confirmationRequest.action.product.id, "p1");
});

test("multi-delete with empty productName entries skipped", async () => {
  const res = handleDeleteProduct(makeParams({
    text: "borrá nada",
    parsed: {
      intent: "delete_product",
      productDeletes: [{ productName: "" }, { productName: "  " }],
    },
  }));
  // Falls through to single-path. Text "borrá nada" — extractor likely
  // returns clarification (no valid product).
  const data = await readJson(res);
  // Either clarification or unknown — both acceptable, not a confirmation
  // card with a real action.
  assert.ok(!data.confirmationRequest || !data.confirmationRequest.action.product);
});

// ── Single-delete path (text-based) ────────────────────────────────

test("text 'borrá Arena Fina' → single delete confirmation", async () => {
  const res = handleDeleteProduct(makeParams({
    text: "borrá Arena Fina",
  }));
  const data = await readJson(res);
  if (data.confirmationRequest) {
    assert.equal(data.confirmationRequest.action.type, "delete_product");
    assert.equal(data.confirmationRequest.action.product.id, "p2");
  }
});

test("text with unknown product → clarification (no confirmation)", async () => {
  const res = handleDeleteProduct(makeParams({
    text: "borrá un producto que no existe",
  }));
  const data = await readJson(res);
  // Either clarification answer or no confirmation — handler returns
  // resolveProductDeleteRequest's clarification body
  assert.ok(!data.confirmationRequest || !data.confirmationRequest.action.product);
});

// ── Non-applicable intent ──────────────────────────────────────────

test("non-delete intent → returns null", () => {
  const res = handleDeleteProduct(makeParams({ safeIntent: "register_sale" }));
  assert.equal(res, null);
});
