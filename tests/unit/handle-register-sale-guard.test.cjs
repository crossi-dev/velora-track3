// Money-path guard: handleRegisterSale (post-model path) must NOT emit
// register_sale action when matchedProductId is null or hallucinated.
//
// This is the root-cause bug from revision-251: the LLM Slow Path fires when
// the deterministic NLU misses the intent. The model returns
// intent="register_sale" with matchedProductId: null. The pre-Wave-1C code
// in handleRegisterSale built baseResult and could return it at the end of
// the function (line ~200) without any null-product check. This test pins the
// fix: null/hallucinated IDs must produce clarification with primaryAction=null.

// Skip env validation so prisma.ts can be imported without a real DB URL.
process.env.SKIP_ENV_VALIDATION = "1";
process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
process.env.AUTH_SECRET = "test-secret-for-unit-tests";

const assert = require("node:assert/strict");
const test = require("node:test");

// handleRegisterSale is an IntentHandler — async function (params) => HandlerResult.
// We import it via the intent-handlers/sale module.
const { handleRegisterSale } = require("../../src/app/api/business-assistant/_lib/intent-handlers/sale.ts");

const CATALOG_PRODUCTS = [
  { id: "prod-real-001", name: "Tuerca M8", sku: null, price: 250, stock: 50 },
  { id: "prod-real-002", name: "Tornillo 3mm", sku: null, price: 120, stock: 100 },
];

const CATALOG_CUSTOMERS = [
  { id: "cli-001", name: "Juan Pérez" },
];

function makeParams(parsedOverrides = {}, overrides = {}) {
  return {
    text: "vendí una tuerca a Juan",
    locale: "es-AR",
    safeIntent: "register_sale",
    parsed: {
      intent: "register_sale",
      matchedProductId: "prod-real-001",
      matchedCustomerId: "cli-001",
      product: { name: "Tuerca M8" },
      confidence: 0.9,
      ...parsedOverrides,
    },
    answer: "Registrando venta.",
    fullCatalogProducts: CATALOG_PRODUCTS,
    fullCatalogCustomers: CATALOG_CUSTOMERS,
    fullCatalogSuppliers: [],
    productInfoDirectory: CATALOG_PRODUCTS,
    businessId: "biz-test-001",
    context: { business: { currency: "ARS" }, catalog: { customers: CATALOG_CUSTOMERS }, activeRules: [] },
    trace: { add: () => {}, toJSON: () => ({}) },
  };
}

// ── null matchedProductId → clarification, no action ────────────────────────

test("handleRegisterSale guard: null matchedProductId returns clarification without action", async () => {
  const params = makeParams({
    matchedProductId: null,
    matchedCustomerId: "cli-001",
    product: { name: "tuerca" },
  });
  const result = await handleRegisterSale(params);
  assert.ok(result !== null, "must return a result (not null)");
  // result is HandlerResult — either NextResponse or { answer, primaryAction?, ... }
  // Since it returns a plain object when clarifying:
  assert.ok(typeof result === "object" && !(result instanceof Response), "must return a body object");
  const body = result;
  assert.ok(body.answer, "must return an answer");
  assert.equal(body.primaryAction, null, "must NOT emit primaryAction");
  assert.match(body.answer, /producto|catálogo/i);
});

test("handleRegisterSale guard: null matchedProductId with no product name returns generic clarification", async () => {
  const params = makeParams({
    matchedProductId: null,
    matchedCustomerId: "cli-001",
    product: null,
  });
  const result = await handleRegisterSale(params);
  assert.ok(result !== null);
  assert.equal(result.primaryAction, null);
  assert.match(result.answer, /producto/i);
});

test("handleRegisterSale guard: hallucinated matchedProductId (not in catalog) returns clarification", async () => {
  const params = makeParams({
    matchedProductId: "hallucinated-id-xyz-9999",
    matchedCustomerId: "cli-001",
    product: { name: "Tuerca Fantasma" },
  });
  const result = await handleRegisterSale(params);
  assert.ok(result !== null);
  assert.equal(result.primaryAction, null);
  assert.match(result.answer, /catálogo|producto/i);
});

// ── wrong safeIntent → handler skips (returns null) ─────────────────────────

test("handleRegisterSale: returns null for non-register_sale intent", async () => {
  const params = makeParams({}, {});
  params.safeIntent = "stock_load";
  const result = await handleRegisterSale(params);
  assert.equal(result, null, "must return null for non-register_sale intent");
});

// ── valid matchedProductId in catalog → action proceeds ─────────────────────

test("handleRegisterSale guard: valid matchedProductId in catalog emits primaryAction", async () => {
  const params = makeParams({
    matchedProductId: "prod-real-001",
    matchedCustomerId: "cli-001",
    product: { name: "Tuerca M8" },
    // No saleDraft — falls through to baseResult path
    saleDraft: null,
  });
  const result = await handleRegisterSale(params);
  assert.ok(result !== null);
  // result may be a NextResponse (from postModelResponse) or a body object
  if (result instanceof Response) return; // NextResponse — guard passed
  assert.ok(result.primaryAction, "valid product must emit primaryAction");
  assert.equal(result.primaryAction.type, "register_sale");
  assert.equal(result.primaryAction.matchedProductId, "prod-real-001");
});
