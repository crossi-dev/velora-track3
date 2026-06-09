const assert = require("node:assert/strict");
const test = require("node:test");

const {
  handleBulkPriceUpdate,
} = require("../../src/app/api/business-assistant/_lib/intent-handlers/bulk-price.ts");

// Minimal PostModelIntentParams factory — only fills the fields the
// bulk-price handler actually reads. Add more if a future test needs them.
function makeParams(overrides = {}) {
  return {
    text: "",
    locale: "es-AR",
    safeIntent: "bulk_price_update",
    answer: "Procesando.",
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

async function readJson(response) {
  return await response.json();
}

// ── Happy paths ─────────────────────────────────────────────────────

test("up + percentage produces a confirmation request", async () => {
  const res = handleBulkPriceUpdate(makeParams({
    parsed: { intent: "bulk_price_update", bulkPriceUpdate: { amount: 10, mode: "percentage", direction: "up", target: "all" } },
  }));
  const data = await readJson(res);
  assert.ok(data.confirmationRequest);
  assert.equal(data.confirmationRequest.action.type, "bulk_price_update");
  assert.equal(data.confirmationRequest.action.direction, "up");
  assert.equal(data.confirmationRequest.action.mode, "percentage");
  assert.equal(data.confirmationRequest.action.amount, 10);
  assert.match(data.confirmationRequest.message, /Aumentar/);
});

test("down + absolute produces 'Reducir' confirmation", async () => {
  const res = handleBulkPriceUpdate(makeParams({
    parsed: { intent: "bulk_price_update", bulkPriceUpdate: { amount: 200, mode: "absolute", direction: "down", target: "all" } },
  }));
  const data = await readJson(res);
  assert.match(data.confirmationRequest.message, /Reducir/);
});

test("set + absolute produces 'Fijar' confirmation", async () => {
  const res = handleBulkPriceUpdate(makeParams({
    parsed: { intent: "bulk_price_update", bulkPriceUpdate: { amount: 50, mode: "absolute", direction: "set", target: "all" } },
  }));
  const data = await readJson(res);
  assert.match(data.confirmationRequest.message, /Fijar/);
  assert.equal(data.confirmationRequest.action.direction, "set");
});

// ── Reject paths ────────────────────────────────────────────────────

test("missing mode → asks for clarification", async () => {
  const res = handleBulkPriceUpdate(makeParams({
    parsed: { intent: "bulk_price_update", bulkPriceUpdate: { amount: 10, mode: null, direction: "up", target: "all" } },
  }));
  const data = await readJson(res);
  assert.match(data.answer, /porcentaje o un monto/);
  assert.equal(data.confirmationRequest, undefined);
});

test("zero amount → asks for amount", async () => {
  const res = handleBulkPriceUpdate(makeParams({
    parsed: { intent: "bulk_price_update", bulkPriceUpdate: { amount: 0, mode: "percentage", direction: "up", target: "all" } },
  }));
  const data = await readJson(res);
  assert.match(data.answer, /monto o porcentaje/);
});

test("percentage > 100 with direction down → rejected", async () => {
  const res = handleBulkPriceUpdate(makeParams({
    parsed: { intent: "bulk_price_update", bulkPriceUpdate: { amount: 150, mode: "percentage", direction: "down", target: "all" } },
  }));
  const data = await readJson(res);
  assert.match(data.answer, /no se puede bajar más del 100/i);
});

test("set + percentage → rejected with set-specific message", async () => {
  const res = handleBulkPriceUpdate(makeParams({
    parsed: { intent: "bulk_price_update", bulkPriceUpdate: { amount: 50, mode: "percentage", direction: "set", target: "all" } },
  }));
  const data = await readJson(res);
  assert.match(data.answer, /fijar precios.*monto en pesos/i);
});

test("empty catalog → 'no hay productos' answer", async () => {
  const res = handleBulkPriceUpdate(makeParams({
    fullCatalogProducts: [],
    parsed: { intent: "bulk_price_update", bulkPriceUpdate: { amount: 10, mode: "percentage", direction: "up", target: "all" } },
  }));
  const data = await readJson(res);
  assert.match(data.answer, /no hay productos/i);
});

test("non-bulk intent → handler returns null (passes through)", () => {
  const res = handleBulkPriceUpdate(makeParams({ safeIntent: "register_sale" }));
  assert.equal(res, null);
});

// ── Confirmation message singular vs plural ─────────────────────────

test("singular target → 'el precio de \"X\"' (no number)", async () => {
  const res = handleBulkPriceUpdate(makeParams({
    fullCatalogProducts: [{ id: "p1", name: "Solo Producto", sku: null }],
    parsed: { intent: "bulk_price_update", bulkPriceUpdate: { amount: 10, mode: "percentage", direction: "up", target: "all" } },
  }));
  const data = await readJson(res);
  // 1 product → "el precio de" (singular form)
  assert.match(data.confirmationRequest.message, /el precio de/);
});

test("multiple targets → 'los precios de N productos'", async () => {
  const res = handleBulkPriceUpdate(makeParams({
    parsed: { intent: "bulk_price_update", bulkPriceUpdate: { amount: 10, mode: "percentage", direction: "up", target: "all" } },
  }));
  const data = await readJson(res);
  assert.match(data.confirmationRequest.message, /2 productos/);
});
