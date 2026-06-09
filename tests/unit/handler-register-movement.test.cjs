const assert = require("node:assert/strict");
const test = require("node:test");

const {
  handleRegisterMovement,
} = require("../../src/app/api/business-assistant/_lib/intent-handlers/movement.ts");

function makeParams(overrides = {}) {
  return {
    text: "",
    locale: "es-AR",
    safeIntent: "register_movement",
    answer: "Registrando.",
    parsed: { intent: "register_movement", movementDraft: null },
    context: {},
    fullCatalogProducts: [],
    fullCatalogCustomers: [],
    fullCatalogSuppliers: [],
    productInfoDirectory: [],
    trace: { add: () => {}, toJSON: () => null },
    ...overrides,
  };
}

const readJson = (r) => r.json();

// ── Happy paths ─────────────────────────────────────────────────────

test("valid purchase movement → confirmation request", async () => {
  const res = handleRegisterMovement(makeParams({
    parsed: { intent: "register_movement", movementDraft: { movementType: "purchase", amount: 5000, description: "luz" } },
  }));
  const data = await readJson(res);
  assert.ok(data.confirmationRequest);
  assert.equal(data.confirmationRequest.action.type, "register_movement");
  assert.equal(data.confirmationRequest.action.movement.movementType, "purchase");
  assert.equal(data.confirmationRequest.action.movement.amount, 5000);
  assert.match(data.confirmationRequest.message, /compra/);
});

test("salary movement renders 'sueldo' label", async () => {
  const res = handleRegisterMovement(makeParams({
    parsed: { intent: "register_movement", movementDraft: { movementType: "salary", amount: 100000, description: "sueldo Juan" } },
  }));
  const data = await readJson(res);
  assert.match(data.confirmationRequest.message, /sueldo/);
});

test("income movement renders 'ingreso' label", async () => {
  const res = handleRegisterMovement(makeParams({
    parsed: { intent: "register_movement", movementDraft: { movementType: "income", amount: 5000, description: "extra" } },
  }));
  const data = await readJson(res);
  assert.match(data.confirmationRequest.message, /ingreso/);
});

// ── Reject paths ────────────────────────────────────────────────────

test("missing movementDraft → asks for type+amount", async () => {
  const res = handleRegisterMovement(makeParams());
  const data = await readJson(res);
  assert.match(data.answer, /tipo.*movimiento.*cuánto/i);
  assert.equal(data.confirmationRequest, undefined);
});

test("unknown movementType → rejects with allowed-types message", async () => {
  const res = handleRegisterMovement(makeParams({
    parsed: { intent: "register_movement", movementDraft: { movementType: "rent", amount: 5000, description: "alquiler" } },
  }));
  const data = await readJson(res);
  assert.match(data.answer, /tipo de movimiento/i);
});

test("zero amount → asks for amount", async () => {
  const res = handleRegisterMovement(makeParams({
    parsed: { intent: "register_movement", movementDraft: { movementType: "purchase", amount: 0, description: "test" } },
  }));
  const data = await readJson(res);
  assert.match(data.answer, /cuánto.*movimiento/i);
});

test("non-numeric amount (NaN) → asks for amount", async () => {
  const res = handleRegisterMovement(makeParams({
    parsed: { intent: "register_movement", movementDraft: { movementType: "purchase", amount: "abc", description: "x" } },
  }));
  const data = await readJson(res);
  assert.match(data.answer, /cuánto/i);
});

test("non-movement intent → handler returns null", () => {
  const res = handleRegisterMovement(makeParams({ safeIntent: "register_sale" }));
  assert.equal(res, null);
});

// ── Confirmation message format ─────────────────────────────────────

test("confirmation includes amount in ARS currency format", async () => {
  const res = handleRegisterMovement(makeParams({
    parsed: { intent: "register_movement", movementDraft: { movementType: "tax", amount: 12500, description: "monotributo" } },
  }));
  const data = await readJson(res);
  // ARS formatter uses "$" prefix and "12.500" (dot as thousands separator)
  assert.match(data.confirmationRequest.message, /12\.500/);
  assert.match(data.confirmationRequest.message, /monotributo/);
});
