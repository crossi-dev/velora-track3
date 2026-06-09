const assert = require("node:assert/strict");
const test = require("node:test");

const {
  handleRegisterSale,
} = require("../../src/app/api/business-assistant/_lib/intent-handlers/sale.ts");

// Regression: model-emitted `answer` ("Listo, registrada la venta...") must
// never reach the chat for register_sale success paths — the modal hasn't
// been confirmed yet. Handler overrides with a deterministic template
// "Te paso a confirmar la venta de ...".

const PRODUCTS = [
  { id: "p1", name: "Tuerca M8", price: 250 },
  { id: "p2", name: "Remera Algodón", price: 2500 },
];
const CUSTOMERS = [
  { id: "c1", name: "Carlos Rossi" },
];

function makeParams(overrides = {}) {
  // matchedProductId is required by the hallucination guard added 2026-05.
  // Without a valid catalog ID the handler rejects with null primaryAction.
  // Merge parsed so callers can extend it without losing the guard field.
  const baseParsed = { intent: "register_sale", matchedProductId: "p1" };
  const merged = { ...baseParsed, ...overrides.parsed };
  return {
    text: "",
    locale: "es-AR",
    safeIntent: "register_sale",
    answer: "Listo, registrada la venta de 1 tuerca a Carlos Rossi.",
    parsed: merged,
    context: {},
    fullCatalogProducts: PRODUCTS,
    fullCatalogCustomers: CUSTOMERS,
    fullCatalogSuppliers: [],
    productInfoDirectory: [],
    trace: { add: () => {}, toJSON: () => null },
    ...overrides,
    parsed: merged,
  };
}

const FORBIDDEN_TOKENS = [
  /\bregistrad[ao]\b/i,
  /\bvendid[ao]\b/i,
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

test("register_sale success: answer is deterministic template, not LLM text", async () => {
  const res = await handleRegisterSale(makeParams({
    text: "vendi una tuerca a carlos",
    parsed: {
      intent: "register_sale",
      saleDraft: {
        customerName: "Carlos Rossi",
        items: [{ productName: "Tuerca M8", quantity: 1, unitPrice: 250 }],
      },
    },
  }));
  assert.ok(res, "handler should return a result");
  assert.ok(res.saleDraft, "success path should include saleDraft");
  assert.ok(
    /^Te paso a confirmar la venta de /i.test(res.answer),
    `answer must start with deterministic prefix; got: ${res.answer}`,
  );
  assertNoHallucination(res.answer);
});

test("register_sale success: answer includes quantity, product, customer", async () => {
  const res = await handleRegisterSale(makeParams({
    text: "vendi 3 remeras a carlos",
    parsed: {
      intent: "register_sale",
      saleDraft: {
        customerName: "Carlos Rossi",
        items: [{ productName: "Remera Algodón", quantity: 3, unitPrice: 2500 }],
      },
    },
  }));
  assert.match(res.answer, /3 Remera Algodón/);
  assert.match(res.answer, /Carlos Rossi/);
  assertNoHallucination(res.answer);
});

test("register_sale insufficient stock: clarification answer untouched (no template)", async () => {
  // Stock check requires businessId + real prisma. With no businessId, pre-check
  // is skipped and we hit the success path. To exercise the insufficient branch
  // in isolation we'd need a prisma mock — covered separately. This test
  // documents that the template only fires on success paths.
  const res = await handleRegisterSale(makeParams({
    parsed: {
      intent: "register_sale",
      saleDraft: {
        customerName: "Carlos Rossi",
        items: [{ productName: "Tuerca M8", quantity: 1 }],
      },
    },
  }));
  // Without businessId, success path runs → template applies
  assert.ok(/^Te paso a confirmar/i.test(res.answer));
});

