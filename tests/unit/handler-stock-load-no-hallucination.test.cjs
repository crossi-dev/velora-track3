const assert = require("node:assert/strict");
const test = require("node:test");

const {
  handleStockLoad,
} = require("../../src/app/api/business-assistant/_lib/intent-handlers/stock.ts");

// Regression: model-emitted `answer` ("Listo, cargué el stock...") must
// never reach the chat for stock_load success paths — the modal hasn't
// been confirmed yet. Handler overrides with a deterministic template
// "Te paso a confirmar la carga de ...".

const PRODUCTS = [
  { id: "p1", name: "Clavo 2 pulgadas" },
  { id: "p2", name: "Cemento" },
];

function makeParams(overrides = {}) {
  return {
    text: "",
    locale: "es-AR",
    safeIntent: "stock_load",
    answer: "Listo, cargué 50 clavos. Ya está.",
    parsed: { intent: "stock_load" },
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
  /\bcargu[eé]\b/i,
  /\bcargad[ao]\b/i,
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

test("stock_load success: answer is deterministic template, not LLM text", () => {
  const res = handleStockLoad(makeParams({
    parsed: {
      intent: "stock_load",
      stockDraft: { itemName: "Clavo 2 pulgadas", quantity: 50, unitPrice: 200 },
    },
  }));
  assert.ok(res && typeof res === "object" && "primaryAction" in res);
  assert.ok(
    /^Te paso a confirmar la carga de /i.test(res.answer),
    `answer must start with deterministic prefix; got: ${res.answer}`,
  );
  assertNoHallucination(res.answer);
});

test("stock_load success: answer includes quantity and item name", () => {
  const res = handleStockLoad(makeParams({
    parsed: {
      intent: "stock_load",
      stockDraft: { itemName: "Cemento", quantity: 20, unitPrice: 1500 },
    },
  }));
  assert.match(res.answer, /20 Cemento/);
  assertNoHallucination(res.answer);
});

test("stock_load multi-item: answer lists all items deterministically", () => {
  const res = handleStockLoad(makeParams({
    parsed: {
      intent: "stock_load",
      stockDrafts: [
        { itemName: "Clavo 2 pulgadas", quantity: 50, unitPrice: 200 },
        { itemName: "Cemento", quantity: 20, unitPrice: 1500 },
      ],
    },
  }));
  assert.match(res.answer, /50 Clavo 2 pulgadas/);
  assert.match(res.answer, /20 Cemento/);
  assertNoHallucination(res.answer);
});

test("stock_load with supplier: answer mentions supplier", () => {
  const res = handleStockLoad(makeParams({
    parsed: {
      intent: "stock_load",
      stockDraft: { itemName: "Clavo 2 pulgadas", quantity: 50, unitPrice: 200, supplierName: "Ferretería Norte" },
    },
  }));
  assert.match(res.answer, /Ferretería Norte/);
  assertNoHallucination(res.answer);
});
