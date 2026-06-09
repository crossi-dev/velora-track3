const assert = require("node:assert/strict");
const test = require("node:test");

const {
  handleCreatePurchaseRequest,
} = require("../../src/app/api/business-assistant/_lib/intent-handlers/purchase-request.ts");

// Regression: model-emitted `answer` ("Listo, armé el pedido...") must
// never reach the chat for create_purchase_request success paths — the modal
// hasn't been confirmed yet. Handler overrides with a deterministic template
// "Te paso a confirmar el pedido de ...".

function makeParams(overrides = {}) {
  return {
    text: "",
    locale: "es-AR",
    safeIntent: "create_purchase_request",
    answer: "Listo, armé el pedido. Ya está.",
    parsed: { intent: "create_purchase_request" },
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
  /\barm[eé]\b/i,
  /\barmad[ao]\b/i,
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

test("create_purchase_request success: answer is deterministic, not LLM text", async () => {
  const res = handleCreatePurchaseRequest(makeParams({
    parsed: {
      intent: "create_purchase_request",
      purchaseRequestDraft: {
        supplierName: "Distribuidora ABC",
        items: [{ itemName: "harina", quantity: 50, unitPrice: 1500 }],
      },
    },
  }));
  const data = await res.json();
  assert.ok(
    /^Te paso a confirmar el pedido/i.test(data.answer),
    `answer must start with deterministic prefix; got: ${data.answer}`,
  );
  assertNoHallucination(data.answer);
});

test("create_purchase_request success: answer mentions item, quantity, supplier", async () => {
  const res = handleCreatePurchaseRequest(makeParams({
    parsed: {
      intent: "create_purchase_request",
      purchaseRequestDraft: {
        supplierName: "Distribuidora ABC",
        items: [{ itemName: "harina", quantity: 50, unitPrice: 1500 }],
      },
    },
  }));
  const data = await res.json();
  assert.match(data.answer, /50/);
  assert.match(data.answer, /harina/);
  assert.match(data.answer, /Distribuidora ABC/);
  assertNoHallucination(data.answer);
});
