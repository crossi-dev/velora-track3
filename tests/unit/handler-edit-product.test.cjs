const assert = require("node:assert/strict");
const test = require("node:test");

const {
  handleEditProduct,
} = require("../../src/app/api/business-assistant/_lib/intent-handlers/product.ts");

const PRODUCTS = [
  { id: "p1", name: "Arena Gruesa" },
  { id: "p2", name: "Cemento" },
  { id: "p3", name: "Clavo 2 pulgadas" },
];

function makeParams(overrides = {}) {
  return {
    text: "",
    locale: "es-AR",
    safeIntent: "edit_product",
    answer: "Procesando.",
    parsed: { intent: "edit_product" },
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

// ── Intent gate ──────────────────────────────────────────────────────

test("returns null for non-edit_product intents", () => {
  assert.equal(handleEditProduct(makeParams({ safeIntent: "register_sale" })), null);
});

// ── Multi-edit path ──────────────────────────────────────────────────

test("multi-edit with 2 valid prices → multi_edit_product confirmation", async () => {
  const res = handleEditProduct(makeParams({
    parsed: {
      intent: "edit_product",
      productEdits: [
        { productName: "Arena Gruesa", field: "price", value: 1500 },
        { productName: "Cemento", field: "price", value: 2500 },
      ],
    },
  }));
  const data = await readJson(res);
  assert.equal(data.confirmationRequest.action.type, "multi_edit_product");
  assert.equal(data.confirmationRequest.action.edits.length, 2);
});

test("multi-edit with negative value → skipped (negative entry filtered, valid one kept)", async () => {
  const res = handleEditProduct(makeParams({
    parsed: {
      intent: "edit_product",
      productEdits: [
        { productName: "Arena Gruesa", field: "price", value: 1500 },
        { productName: "Cemento", field: "price", value: -100 }, // skipped
      ],
    },
  }));
  const data = await readJson(res);
  // Multi-edit must keep the valid Arena Gruesa edit and drop the negative one.
  // If no confirmationRequest is returned, the handler silently lost both edits.
  assert.ok(data.confirmationRequest, "expected confirmation card with the valid edit");
  assert.equal(data.confirmationRequest.action.edits.length, 1);
  assert.equal(data.confirmationRequest.action.edits[0].productName, "Arena Gruesa");
});

test("multi-edit with non-existent products falls through to clarification", async () => {
  const res = handleEditProduct(makeParams({
    parsed: {
      intent: "edit_product",
      productEdits: [
        { productName: "Producto Inexistente", field: "price", value: 1500 },
        { productName: "Otro Inexistente", field: "price", value: 2000 },
      ],
    },
  }));
  // No valid matches → MUST fall through to a clarification answer.
  // A confirmationRequest here would mean the handler accepted phantom products.
  const data = await readJson(res);
  assert.ok(data.answer, "expected clarification answer for unknown products");
  assert.equal(data.confirmationRequest, undefined,
    "must NOT produce a confirmationRequest when no products match");
});

// ── Single-edit path ─────────────────────────────────────────────────

test("single edit with valid match → primaryAction with edit_product type", async () => {
  const res = handleEditProduct(makeParams({
    text: "cambiá el precio de cemento a 2500",
    parsed: {
      intent: "edit_product",
      product: { name: "Cemento" },
      productEdit: { field: "price", value: "2500" },
      matchedProductId: "p2",
    },
  }));
  // With matchedProductId resolved + valid field/value, handler MUST emit
  // a HandlerBody with primaryAction. A NextResponse clarification would
  // mean the resolver discarded a perfectly-formed edit.
  assert.ok(res && typeof res === "object" && "primaryAction" in res,
    `expected HandlerBody with primaryAction, got: ${JSON.stringify(res)}`);
  assert.equal(res.primaryAction.type, "edit_product");
});
