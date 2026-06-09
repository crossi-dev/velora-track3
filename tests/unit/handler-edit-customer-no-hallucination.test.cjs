const assert = require("node:assert/strict");
const test = require("node:test");

const {
  handleEditCustomer,
} = require("../../src/app/api/business-assistant/_lib/intent-handlers/customer.ts");

// Regression: model-emitted `answer` ("Listo, actualicé al cliente...") must
// never reach the chat for edit_customer success paths — the modal hasn't
// been confirmed yet. Handler overrides with a deterministic template
// "Te paso a confirmar la actualización...".

const CUSTOMERS = [
  { id: "cust-1", name: "Juan Pérez" },
  { id: "cust-2", name: "María López" },
];

function makeParams(overrides = {}) {
  return {
    text: "",
    locale: "es-AR",
    safeIntent: "edit_customer",
    answer: "Listo, actualicé al cliente. Ya está.",
    parsed: { intent: "edit_customer" },
    context: {},
    fullCatalogProducts: [],
    fullCatalogCustomers: CUSTOMERS,
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

test("edit_customer success: answer is deterministic, not LLM text", () => {
  const res = handleEditCustomer(makeParams({
    text: "cambiar el teléfono de María López a 2615559999",
  }));
  assert.ok(res && typeof res === "object" && "primaryAction" in res);
  assert.ok(
    /^Te paso a confirmar la actualización/i.test(res.answer),
    `answer must start with deterministic prefix; got: ${res.answer}`,
  );
  assertNoHallucination(res.answer);
});

test("edit_customer success: answer mentions customer and value", () => {
  const res = handleEditCustomer(makeParams({
    text: "cambiar el teléfono de María López a 2615559999",
  }));
  assert.match(res.answer, /María López/);
  assert.match(res.answer, /2615559999/);
  assertNoHallucination(res.answer);
});
