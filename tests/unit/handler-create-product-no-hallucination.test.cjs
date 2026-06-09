const assert = require("node:assert/strict");
const test = require("node:test");

const {
  handleCreateProduct,
} = require("../../src/app/api/business-assistant/_lib/intent-handlers/product-create.ts");

// Regression: model-emitted `answer` ("Listo, creé el producto...") must
// never reach the chat for create_product success paths — the modal hasn't
// been confirmed yet. Handler overrides with a deterministic template
// "Te paso a confirmar el alta del producto ...".

function makeParams(overrides = {}) {
  return {
    text: "",
    locale: "es-AR",
    safeIntent: "create_product",
    answer: "Listo, creé el producto. Ya está.",
    parsed: { intent: "create_product" },
    context: {},
    fullCatalogProducts: [],
    fullCatalogCustomers: [],
    fullCatalogSuppliers: [],
    productInfoDirectory: [],
    trace: { add: () => {}, toJSON: () => null },
    ...overrides,
  };
}

const FORBIDDEN_TOKENS = [
  /\bcre[eé]\b/i,
  /\bcread[ao]\b/i,
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

test("create_product success: answer is deterministic, not LLM text", async () => {
  const res = handleCreateProduct(makeParams({
    parsed: {
      intent: "create_product",
      productDraft: { name: "Tornillo M5", price: 100, stock: 50 },
    },
  }));
  const data = await res.json();
  assert.ok(
    /^Te paso a confirmar el alta del producto/i.test(data.answer),
    `answer must start with deterministic prefix; got: ${data.answer}`,
  );
  assertNoHallucination(data.answer);
});

test("create_product success: answer mentions name, price, stock", async () => {
  const res = handleCreateProduct(makeParams({
    parsed: {
      intent: "create_product",
      productDraft: { name: "Tornillo M5", price: 100, stock: 50 },
    },
  }));
  const data = await res.json();
  assert.match(data.answer, /Tornillo M5/);
  assert.match(data.answer, /\$100/);
  assert.match(data.answer, /50/);
  assertNoHallucination(data.answer);
});
