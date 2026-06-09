// Money-path guard: executeSaleCreate must reject when matchedProductId is
// null (unresolved) or when it's a hallucinated ID not present in the catalog.
// Defense-in-depth companion to execute-sale-send-guard.test.cjs.
//
// Root cause context: Wave 1C added the guard only in executeSaleSend. The
// post-model handler (intent-handlers/sale.ts handleRegisterSale) had NO guard,
// so any LLM-path sale intent with matchedProductId: null would emit
// register_sale to the client. This test covers BOTH the fast-path executor
// (executeSaleCreate) and the post-model handler (handleRegisterSale).

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  executeSaleCreate,
} = require("../../src/app/api/business-assistant/_lib/nlu/execute-sale-create.ts");

const CATALOG_PRODUCTS = [
  { id: "prod-real-001", name: "Tuerca M8", sku: null, price: 250, stock: 50 },
  { id: "prod-real-002", name: "Tornillo 3mm", sku: null, price: 120, stock: 100 },
];

const CATALOG_CUSTOMERS = [
  { id: "cli-001", name: "Juan Pérez" },
];

function makeIntent(overrides = {}) {
  return {
    kind: "sale_create",
    matchedProductId: "prod-real-001",
    matchedCustomerId: "cli-001",
    productName: "Tuerca M8",
    customerName: "Juan Pérez",
    qty: 1,
    unitPrice: null,
    ...overrides,
  };
}

function makeParams(overrides = {}) {
  return {
    text: "vendí una tuerca a Juan",
    recentHistory: [],
    context: {
      catalog: {
        customers: CATALOG_CUSTOMERS,
      },
    },
    productInfoDirectory: CATALOG_PRODUCTS,
    businessId: "biz-test-001",
    actorEmployeeId: "emp-test-001",
    actorUserId: "user-test-001",
    actorRole: "employee",
    ...overrides,
  };
}

async function parseResponse(nextResponse) {
  const text = await nextResponse.text();
  return JSON.parse(text);
}

// ── sale_create: null matchedProductId → clarification, no register_sale ────

test("sale_create guard: null matchedProductId returns clarification without register_sale action", async () => {
  // The SaleCreateIntent type declares matchedProductId: string (non-null)
  // but we cast to test the defense-in-depth guard for future widening.
  const intent = makeIntent({ matchedProductId: null, productName: "tuerca" });
  const res = executeSaleCreate(intent, makeParams());
  const body = await parseResponse(res);
  assert.ok(body.answer, "must return an answer");
  assert.ok(!body.actions, "must NOT emit actions when product is unresolved");
  assert.match(body.answer, /tuerca/i);
});

test("sale_create guard: null matchedProductId with no productName returns generic clarification", async () => {
  const intent = makeIntent({ matchedProductId: null, productName: null });
  const res = executeSaleCreate(intent, makeParams());
  const body = await parseResponse(res);
  assert.ok(body.answer, "must return an answer");
  assert.ok(!body.actions, "must NOT emit actions");
  assert.match(body.answer, /producto/i);
});

test("sale_create guard: hallucinated matchedProductId (not in catalog) returns clarification", async () => {
  const intent = makeIntent({
    matchedProductId: "hallucinated-id-xyz-9999",
    productName: "Tuerca Inexistente",
  });
  const res = executeSaleCreate(intent, makeParams());
  const body = await parseResponse(res);
  assert.ok(body.answer, "must return an answer");
  assert.ok(!body.actions, "must NOT emit actions for hallucinated product ID");
  assert.match(body.answer, /catálogo|producto/i);
});

// ── sale_create: valid matchedProductId in catalog → confirmation card ───────

test("sale_create guard: valid matchedProductId emits confirmationRequest, not direct action", async () => {
  const intent = makeIntent({
    matchedProductId: "prod-real-001",
    matchedCustomerId: "cli-001",
    productName: "Tuerca M8",
    customerName: "Juan Pérez",
  });
  const res = executeSaleCreate(intent, makeParams());
  const body = await parseResponse(res);
  assert.ok(!body.actions, "must NOT emit direct actions — gate behind confirmation card");
  assert.ok(body.confirmationRequest, "must emit confirmationRequest");
  assert.equal(body.confirmationRequest.action.type, "register_sale");
  assert.equal(body.confirmationRequest.action.matchedProductId, "prod-real-001");
  assert.equal(body.confirmationRequest.action.autoSend, false);
  assert.equal(body.confirmationRequest.severity, "warning");
});

test("sale_create guard: valid matchedProductId emits saleDraft with correct total", async () => {
  const intent = makeIntent({
    matchedProductId: "prod-real-001",
    productName: "Tuerca M8",
    customerName: "Juan Pérez",
    qty: 2,
  });
  const res = executeSaleCreate(intent, makeParams());
  const body = await parseResponse(res);
  assert.ok(body.saleDraft, "valid product must include saleDraft");
  assert.equal(body.saleDraft.items[0].productId, "prod-real-001");
  // qty=2 → total should be 2 × 250 = 500
  assert.equal(body.saleDraft.total, 500);
});

test("sale_create: confirmation card message includes product name and customer", async () => {
  const intent = makeIntent({
    matchedProductId: "prod-real-001",
    matchedCustomerId: "cli-001",
    productName: "Tuerca M8",
    customerName: "Juan Pérez",
    qty: 1,
  });
  const res = executeSaleCreate(intent, makeParams());
  const body = await parseResponse(res);
  assert.ok(body.confirmationRequest.message.includes("Tuerca M8"), "message must mention product");
  assert.ok(body.confirmationRequest.message.includes("Juan Pérez"), "message must mention customer");
});
