const assert = require("node:assert/strict");
const test = require("node:test");

const {
  handleStockLoad,
  handleAdjustStock,
} = require("../../src/app/api/business-assistant/_lib/intent-handlers/stock.ts");

const PRODUCTS = [
  { id: "p1", name: "Clavo 2 pulgadas" },
  { id: "p2", name: "Cemento" },
];

function makeParams(overrides = {}) {
  return {
    text: "",
    locale: "es-AR",
    safeIntent: "stock_load",
    answer: "Cargando.",
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

const readJson = (r) => r.json();

// ── handleStockLoad: intent gate ─────────────────────────────────────

test("handleStockLoad returns null for non-stock_load", () => {
  assert.equal(handleStockLoad(makeParams({ safeIntent: "register_sale" })), null);
});

// ── handleStockLoad: single draft path ───────────────────────────────

test("single draft with item+quantity → primaryAction with draft", async () => {
  const res = handleStockLoad(makeParams({
    parsed: { intent: "stock_load", stockDraft: { itemName: "Clavo 2 pulgadas", quantity: 50, unitPrice: 200 } },
  }));
  // Returns HandlerBody, not NextResponse
  assert.ok(res && typeof res === "object" && "primaryAction" in res);
  assert.equal(res.primaryAction.type, "stock_load");
  assert.equal(res.primaryAction.draft.items.length, 1);
  assert.equal(res.primaryAction.draft.items[0].itemName, "Clavo 2 pulgadas");
});

test("single draft missing itemName → clarification", async () => {
  const res = handleStockLoad(makeParams({
    parsed: { intent: "stock_load", stockDraft: { itemName: "", quantity: 50 } },
  }));
  // NextResponse.json(...)
  assert.ok(res && typeof res === "object" && "json" in res);
  const data = await readJson(res);
  assert.ok(data.answer);
});

test("single draft missing quantity → clarification", async () => {
  const res = handleStockLoad(makeParams({
    parsed: { intent: "stock_load", stockDraft: { itemName: "Clavo", quantity: null } },
  }));
  const data = await readJson(res);
  assert.ok(data.answer);
});

// ── handleStockLoad: multi draft path ────────────────────────────────

test("multi draft path → multiple items in primaryAction", async () => {
  const res = handleStockLoad(makeParams({
    parsed: {
      intent: "stock_load",
      stockDrafts: [
        { itemName: "Clavo", quantity: 50, unitPrice: 200 },
        { itemName: "Cemento", quantity: 20, unitPrice: 1500 },
      ],
    },
  }));
  assert.ok(res && "primaryAction" in res);
  assert.equal(res.primaryAction.draft.items.length, 2);
});

test("multi draft with missing itemName in first slot → clarification", async () => {
  const res = handleStockLoad(makeParams({
    parsed: {
      intent: "stock_load",
      stockDrafts: [
        { itemName: "", quantity: 50 },
      ],
    },
  }));
  assert.ok(res && "json" in res);
});

// ── handleAdjustStock ────────────────────────────────────────────────

test("handleAdjustStock returns null for non-adjust_stock", () => {
  assert.equal(handleAdjustStock(makeParams({ safeIntent: "stock_load" })), null);
});

test("adjust_stock with valid params → confirmation card with adjust_stock action", async () => {
  const res = handleAdjustStock(makeParams({
    safeIntent: "adjust_stock",
    text: "sumá 10 al stock de cemento",
    parsed: { intent: "adjust_stock", product: { name: "Cemento" }, stockAdjustment: { mode: "increase", quantity: 10 }, matchedProductId: "p2" },
  }));
  // With matchedProductId + mode + quantity all resolved, handler MUST emit
  // a NextResponse with a confirmationRequest. Anything else (null, missing
  // confirmationRequest) means a fully-resolved adjustment was silently dropped.
  assert.ok(res && typeof res === "object" && "json" in res,
    `expected NextResponse, got: ${JSON.stringify(res)}`);
  const data = await readJson(res);
  assert.ok(data.confirmationRequest, "expected confirmationRequest in response");
  assert.equal(data.confirmationRequest.action.type, "adjust_stock");
});
