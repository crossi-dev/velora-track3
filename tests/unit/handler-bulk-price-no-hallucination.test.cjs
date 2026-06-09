const assert = require("node:assert/strict");
const test = require("node:test");

const {
  handleBulkPriceUpdate,
} = require("../../src/app/api/business-assistant/_lib/intent-handlers/bulk-price.ts");

// Regression: model-emitted `answer` ("Listo, actualicé los precios...") must
// never reach the chat for bulk_price_update success paths — the modal hasn't
// been confirmed yet. Handler overrides with a deterministic template
// "Te paso a confirmar la actualización...".

function makeParams(overrides = {}) {
  return {
    text: "",
    locale: "es-AR",
    safeIntent: "bulk_price_update",
    answer: "Listo, actualicé los precios. Ya está.",
    parsed: { intent: "bulk_price_update", bulkPriceUpdate: null },
    context: {},
    fullCatalogProducts: [
      { id: "p1", name: "Producto A", sku: null },
      { id: "p2", name: "Producto B", sku: null },
    ],
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

test("bulk_price_update success: answer is deterministic, not LLM text", async () => {
  const res = handleBulkPriceUpdate(makeParams({
    parsed: {
      intent: "bulk_price_update",
      bulkPriceUpdate: { amount: 10, mode: "percentage", direction: "up", target: "all" },
    },
  }));
  const data = await res.json();
  assert.ok(
    /^Te paso a confirmar la actualización/i.test(data.answer),
    `answer must start with deterministic prefix; got: ${data.answer}`,
  );
  assertNoHallucination(data.answer);
});

test("bulk_price_update success: answer mentions amount and direction", async () => {
  const res = handleBulkPriceUpdate(makeParams({
    parsed: {
      intent: "bulk_price_update",
      bulkPriceUpdate: { amount: 15, mode: "percentage", direction: "down", target: "all" },
    },
  }));
  const data = await res.json();
  assert.match(data.answer, /reducir/i);
  assert.match(data.answer, /15%/);
  assertNoHallucination(data.answer);
});
