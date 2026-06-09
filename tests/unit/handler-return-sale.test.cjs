const assert = require("node:assert/strict");
const test = require("node:test");

const {
  handleReturnSale,
} = require("../../src/app/api/business-assistant/_lib/intent-handlers/return-sale.ts");

// Minimal stub — handleReturnSale needs prisma (for policy amount lookup)
// and enforcePolicy. Both are module-load stubs provided by the test harness
// (prisma.js stub + policy-evaluator is pure logic when role=owner).
// We only test the undoCount threading here; policy auth is tested elsewhere.

// Minimal PostModelIntentParams factory — only fills the fields handleReturnSale reads.
function makeParams(overrides = {}) {
  return {
    safeIntent: "return_sale",
    text: "deshacer la última venta",
    businessId: "biz-test-1",
    actorRole: "owner",
    actorUserId: "usr-test-1",
    actorEmployeeId: null,
    locale: "es-AR",
    answer: "",
    parsed: { intent: "return_sale" },
    context: {},
    fullCatalogProducts: [],
    fullCatalogCustomers: [],
    fullCatalogSuppliers: [],
    productInfoDirectory: [],
    trace: { add: () => {}, toJSON: () => null },
    ...overrides,
  };
}

async function readJson(response) {
  return response.json();
}

// ── undoCount threading ───────────────────────────────────────────────────

test("single undo: text 'deshacer la última venta' → undoCount 1", async () => {
  const res = await handleReturnSale(makeParams({ text: "deshacer la última venta" }));
  assert.ok(res, "handler should return a response");
  const data = await readJson(res);
  assert.ok(data.confirmationRequest, "should include confirmationRequest");
  assert.equal(data.confirmationRequest.action.undoCount, 1);
  assert.match(data.answer, /última venta/i);
});

test("multi undo: 'deshacé las últimas 3 ventas' → undoCount 3", async () => {
  const res = await handleReturnSale(makeParams({ text: "deshacé las últimas 3 ventas" }));
  assert.ok(res, "handler should return a response");
  const data = await readJson(res);
  assert.equal(data.confirmationRequest.action.undoCount, 3);
  assert.match(data.answer, /3 ventas/i);
  assert.match(data.confirmationRequest.message, /3 ventas/i);
});

test("multi undo word: 'anulá las últimas dos ventas' → undoCount 2", async () => {
  const res = await handleReturnSale(makeParams({ text: "anulá las últimas dos ventas" }));
  assert.ok(res, "handler should return a response");
  const data = await readJson(res);
  assert.equal(data.confirmationRequest.action.undoCount, 2);
});

test("clamped at MAX_UNDO_COUNT: 'deshacé las últimas 99 ventas' → undoCount 10", async () => {
  const res = await handleReturnSale(makeParams({ text: "deshacé las últimas 99 ventas" }));
  assert.ok(res, "handler should return a response");
  const data = await readJson(res);
  assert.equal(data.confirmationRequest.action.undoCount, 10);
});

test("undoTarget is always 'sale'", async () => {
  const res = await handleReturnSale(makeParams());
  const data = await readJson(res);
  assert.equal(data.confirmationRequest.action.undoTarget, "sale");
  assert.equal(data.confirmationRequest.action.type, "undo");
});

test("wrong intent → returns null (handler passes through)", async () => {
  const res = await handleReturnSale(makeParams({ safeIntent: "register_sale" }));
  assert.equal(res, null);
});

test("severity is critical for undo confirmations", async () => {
  const res = await handleReturnSale(makeParams());
  const data = await readJson(res);
  assert.equal(data.confirmationRequest.severity, "critical");
});
