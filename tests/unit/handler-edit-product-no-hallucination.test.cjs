const assert = require("node:assert/strict");
const test = require("node:test");

const {
  handleEditProduct,
} = require("../../src/app/api/business-assistant/_lib/intent-handlers/product.ts");

// Regression: model-emitted `answer` ("Listo, actualicé el precio...") must
// never reach the chat for edit_product success paths — the modal hasn't
// been confirmed yet. Handler overrides with a deterministic template
// "Te paso a confirmar la actualización...".

const PRODUCTS = [
  { id: "p1", name: "Cemento" },
  { id: "p2", name: "Clavo 2 pulgadas" },
];

function makeParams(overrides = {}) {
  return {
    text: "",
    locale: "es-AR",
    safeIntent: "edit_product",
    answer: "Listo, actualicé el precio. Ya está.",
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

const FORBIDDEN_TOKENS = [
  /\bactualic[eé]\b/i,
  /\bactualizad[ao]\b/i,
  /\bya está\b/i,
  /\blisto\b/i,
];

function assertNoHallucination(answer) {
  for (const re of FORBIDDEN_TOKENS) {
    assert.ok(
      !re.test(answer),
      `answer must not contain past-tense action token ${re}; got: ${answer}`,
    );
  }
}

test("edit_product success: answer is deterministic, not LLM text", () => {
  const res = handleEditProduct(makeParams({
    text: "cambiá el precio de cemento a 2500",
    parsed: {
      intent: "edit_product",
      product: { name: "Cemento" },
      productEdit: { field: "price", value: "2500" },
      matchedProductId: "p1",
    },
  }));
  assert.ok(res && typeof res === "object" && "primaryAction" in res);
  assert.ok(
    /^Te paso a confirmar la actualización/i.test(res.answer),
    `answer must start with deterministic prefix; got: ${res.answer}`,
  );
  assertNoHallucination(res.answer);
});

test("edit_product success: answer mentions product and value", () => {
  const res = handleEditProduct(makeParams({
    text: "cambiá el precio de cemento a 2500",
    parsed: {
      intent: "edit_product",
      product: { name: "Cemento" },
      productEdit: { field: "price", value: "2500" },
      matchedProductId: "p1",
    },
  }));
  assert.match(res.answer, /Cemento/);
  assert.match(res.answer, /2500/);
  assertNoHallucination(res.answer);
});
