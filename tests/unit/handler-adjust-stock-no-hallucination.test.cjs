const assert = require("node:assert/strict");
const test = require("node:test");

const {
  handleAdjustStock,
} = require("../../src/app/api/business-assistant/_lib/intent-handlers/stock.ts");

// Regression: model-emitted `answer` ("Listo, ajusté el stock...") must
// never reach the chat for adjust_stock success paths — the modal hasn't
// been confirmed yet. Handler overrides with a deterministic template
// "Te paso a confirmar el ajuste...".

const PRODUCTS = [
  { id: "p1", name: "Cemento" },
];

function makeParams(overrides = {}) {
  return {
    text: "",
    locale: "es-AR",
    safeIntent: "adjust_stock",
    answer: "Listo, ajusté el stock. Ya está.",
    parsed: { intent: "adjust_stock" },
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
  /\bajusté\b/i,
  /\bajustad[ao]\b/i,
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

test("adjust_stock increase: answer is deterministic, not LLM text", async () => {
  const res = handleAdjustStock(makeParams({
    text: "sumá 10 al stock de cemento",
    parsed: {
      intent: "adjust_stock",
      product: { name: "Cemento" },
      stockAdjustment: { mode: "increase", quantity: 10 },
      matchedProductId: "p1",
    },
  }));
  const data = await res.json();
  assert.ok(
    /^Te paso a confirmar el ajuste/i.test(data.answer),
    `answer must start with deterministic prefix; got: ${data.answer}`,
  );
  assertNoHallucination(data.answer);
});

test("adjust_stock set: answer mentions product and quantity", async () => {
  const res = handleAdjustStock(makeParams({
    text: "dejá el stock de cemento en 50",
    parsed: {
      intent: "adjust_stock",
      product: { name: "Cemento" },
      stockAdjustment: { mode: "set", quantity: 50 },
      matchedProductId: "p1",
    },
  }));
  const data = await res.json();
  assert.match(data.answer, /Cemento/);
  assert.match(data.answer, /50/);
  assertNoHallucination(data.answer);
});

test("adjust_stock decrease: answer mentions restar", async () => {
  // productInfoDirectory must include the product WITH enough stock so the
  // handler doesn't short-circuit with "no puedo bajar" (stock guard added
  // 2026-05). With stock >= quantity, the confirm prompt uses "restar".
  const res = handleAdjustStock(makeParams({
    text: "restá 5 del stock de cemento",
    parsed: {
      intent: "adjust_stock",
      product: { name: "Cemento" },
      stockAdjustment: { mode: "decrease", quantity: 5 },
      matchedProductId: "p1",
    },
    productInfoDirectory: [{ id: "p1", name: "Cemento", stock: 10 }],
  }));
  const data = await res.json();
  assert.match(data.answer, /restar/i);
  assertNoHallucination(data.answer);
});
