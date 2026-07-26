/**
 * employee-all-intents.test.cjs
 *
 * Two groups:
 *   A) ALLOWED intents — handler executes and returns a valid response (same
 *      handlers as owner; role check is upstream in gateIntentByRole, not inside).
 *   B) BLOCKED intents — isIntentAllowedForRole("companion", intent) === false
 *      AND buildCompanionRefusal returns a warm message (no "permiso denegado").
 */

"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("path");

// ─── require.cache injection ─────────────────────────────────────────────────
// sale.ts → @/lib/prisma (for stock pre-check) and
// agent-event-publishers → @/lib/prisma. Both pull in env.ts at module load
// time which throws when AUTH_SECRET is not set. Inject stubs BEFORE any real
// module is required so the cache short-circuits the real file.
const ROOT = path.resolve(__dirname, "../..");

function injectCacheEntry(relPath, exports) {
  const absPath = path.join(ROOT, relPath);
  require.cache[absPath] = {
    id: absPath, filename: absPath, loaded: true,
    exports, parent: null, children: [], paths: [],
  };
  return absPath;
}

// register.cjs redirects "@/lib/prisma" → tests/_stubs/prisma.js (a Proxy that
// has all model methods as no-ops). Inject into the RESOLVED stub path so the
// cache lookup finds our mock. The stub Proxy is good enough for these tests
// since sale.ts only calls prisma.product.findMany inside a try/catch with
// fail-open (stock pre-check), so returning [] is safe.
//
// agent-event-publishers.ts imports prisma and must be stubbed at its real
// src path (the resolver does NOT redirect it — only @/lib/prisma is redirected).
const STUB_PRISMA_PATH = path.join(ROOT, "tests", "_stubs", "prisma.js");

const INJECTED = [
  // Override the shared stub so any model is a no-op without crashes.
  injectCacheEntry(STUB_PRISMA_PATH, {
    prisma: new Proxy({}, { get: (_, model) => ({ findMany: async () => [], findFirst: async () => null, findUnique: async () => null, create: async () => ({}), createMany: async () => ({ count: 0 }), update: async () => ({}), updateMany: async () => ({ count: 0 }), delete: async () => ({}), count: async () => 0, aggregate: async () => ({}) }) }),
  }),
  // agent-event-publishers is imported by sale.ts for publishReportEvent.
  // It also imports prisma; injecting it avoids the transitive env.ts throw.
  injectCacheEntry(path.join(ROOT, "src/app/api/_lib/agent-event-publishers.ts"), {
    publishReportEvent: async () => {},
    publishEmployeeEvent: async () => {},
    publishAuditOnlyEvent: async () => {},
  }),
];

// Handlers for allowed employee intents
const { handleRegisterSale } = require("../../src/app/api/business-assistant/_lib/intent-handlers/sale.ts");
const { handleStockLoad } = require("../../src/app/api/business-assistant/_lib/intent-handlers/stock.ts");
const { handleBusinessQuery } = require("../../src/app/api/business-assistant/_lib/intent-handlers/business-query.ts");
const { handleReportEvent } = require("../../src/app/api/business-assistant/_lib/intent-handlers/event-report.ts");

// RBAC gate helpers
const { isIntentAllowedForRole, buildCompanionRefusal } = require("../../src/app/api/business-assistant/_lib/intent-permissions.ts");

// Remove injected stubs after all real modules are loaded; functions retain
// references via closure so removing cache entries doesn't affect them.
for (const p of INJECTED) delete require.cache[p];

// ─── helpers ────────────────────────────────────────────────────────────────

const PRODUCTS = [
  { id: "p1", name: "Taladro", sku: null, price: 5000, stock: 3 },
  { id: "p2", name: "Sierra circular", sku: null, price: 8000, stock: 1 },
];
const CUSTOMERS = [{ id: "c1", name: "Juan Pérez" }];
const SUPPLIERS = [{ id: "s1", name: "Proveedor ABC" }];

const CONTEXT = {
  business: { id: "biz-1", name: "Demo", currency: "ARS" },
  products: PRODUCTS.map((p) => ({ name: p.name, price: p.price, stock: p.stock })),
  inventorySummary: { productLines: 2, totalUnits: 4, totalValue: 23000 },
  pendingSales: [],
  recentSales: [],
};

function makeParams(overrides = {}) {
  return {
    text: "",
    locale: "es-AR",
    answer: "Ok.",
    context: CONTEXT,
    fullCatalogProducts: PRODUCTS,
    fullCatalogCustomers: CUSTOMERS,
    fullCatalogSuppliers: SUPPLIERS,
    productInfoDirectory: PRODUCTS,
    purchaseRequestDirectory: [],
    supplierDirectory: SUPPLIERS,
    trace: { add: () => {}, toJSON: () => ({}) },
    businessId: "biz-1",
    ...overrides,
  };
}

async function parseResult(result) {
  if (!result) return null;
  if (typeof result.json === "function") return result.json();
  return result;
}

async function assertHandled(result, label) {
  assert.notEqual(result, null, `${label}: handler returned null`);
  const b = await parseResult(result);
  assert.ok(
    typeof b.answer === "string" || b.primaryAction !== undefined || b.confirmationRequest !== undefined,
    `${label}: missing answer/primaryAction/confirmationRequest — got ${JSON.stringify(b)}`
  );
  return b;
}

const BANNED_REFUSAL_WORDS = ["permiso denegado", "no autorizado", "acceso denegado", "prohibido"];
function assertWarmRefusal(refusal, intent) {
  assert.ok(typeof refusal.answer === "string" && refusal.answer.length > 0, `${intent}: refusal.answer must be a non-empty string`);
  for (const banned of BANNED_REFUSAL_WORDS) {
    assert.ok(
      !refusal.answer.toLowerCase().includes(banned),
      `${intent}: refusal uses bureaucratic language "${banned}" — should be warm`
    );
  }
  assert.equal(refusal.forbiddenIntent, intent, `${intent}: forbiddenIntent mismatch`);
}

// ════════════════════════════════════════════════════════════════════════════
// GROUP A — Allowed employee intents (handler executes correctly)
// ════════════════════════════════════════════════════════════════════════════

// ─── register_sale ──────────────────────────────────────────────────────────

test("companion/register_sale: isIntentAllowedForRole → true", () => {
  assert.ok(isIntentAllowedForRole("companion", "register_sale"), "register_sale must be allowed for employee");
});

test("companion/register_sale: handler executes and returns sale draft", async () => {
  // Must include matchedProductId resolved to a real catalog entry.
  // The handler's money-path guard rejects sales with null/hallucinated IDs
  // (added alongside saleDraft pre-confirm logic — null ID → clarification,
  // not a sale action). "p1" is "Taladro" in PRODUCTS above.
  const r = await handleRegisterSale(makeParams({
    safeIntent: "register_sale",
    text: "vendí 1 taladro",
    parsed: {
      intent: "register_sale",
      matchedProductId: "p1",
      saleDraft: { items: [{ productName: "Taladro", quantity: 1, unitPrice: 5000 }] },
    },
  }));
  const b = await assertHandled(r, "employee/register_sale");
  assert.ok(b.primaryAction?.type === "register_sale" || b.saleDraft, "register_sale: should emit register_sale primaryAction or saleDraft");
});

// ─── stock_load ─────────────────────────────────────────────────────────────

test("companion/stock_load: isIntentAllowedForRole → true", () => {
  assert.ok(isIntentAllowedForRole("companion", "stock_load"), "stock_load must be allowed for employee");
});

test("companion/stock_load: handler executes and returns primaryAction", async () => {
  const r = handleStockLoad(makeParams({
    safeIntent: "stock_load",
    parsed: {
      intent: "stock_load",
      stockDraft: { itemName: "Taladro", quantity: 5, unitPrice: 3000, supplierName: "Proveedor ABC" },
    },
  }));
  const b = await assertHandled(r, "employee/stock_load");
  assert.equal(b.primaryAction?.type, "stock_load", `stock_load action type mismatch: ${b.primaryAction?.type}`);
});

// ─── business_query ──────────────────────────────────────────────────────────

test("companion/business_query: isIntentAllowedForRole → true", () => {
  assert.ok(isIntentAllowedForRole("companion", "business_query"), "business_query must be allowed for employee");
});

test("companion/business_query: stock query returns answer", async () => {
  const r = handleBusinessQuery(makeParams({
    safeIntent: "business_query",
    text: "qué hay en stock",
    parsed: { intent: "business_query" },
    answer: "Taladro 3 u, Sierra 1 u.",
  }));
  const b = await assertHandled(r, "employee/business_query");
  assert.ok(typeof b.answer === "string" && b.answer.length > 0, "business_query: answer must be non-empty");
});

// ─── report_event ─────────────────────────────────────────────────────────────

test("companion/report_event: isIntentAllowedForRole → true", () => {
  assert.ok(isIntentAllowedForRole("companion", "report_event"), "report_event must be allowed for employee");
});

test("companion/report_event: handler executes, no primaryAction", async () => {
  const r = handleReportEvent(makeParams({
    safeIntent: "report_event",
    parsed: {
      intent: "report_event",
      eventReport: { eventType: "rotura", details: "Se cayó una vitrina", productName: null },
    },
  }));
  const b = await assertHandled(r, "employee/report_event");
  assert.ok(!b.primaryAction, "report_event: should be log-only (no primaryAction)");
});

// ─── answer (conversational) ──────────────────────────────────────────────────

test("companion/answer: isIntentAllowedForRole → true", () => {
  assert.ok(isIntentAllowedForRole("companion", "answer"), "answer must always be allowed");
});

// ════════════════════════════════════════════════════════════════════════════
// GROUP B — Blocked employee intents (warm RBAC refusal)
// ════════════════════════════════════════════════════════════════════════════

const OWNER_ONLY = [
  "edit_product",
  "delete_product",
  "bulk_price_update",
  "adjust_stock",
  "register_movement",
  "create_supplier",
  "edit_supplier",
  "create_product",
  "create_budget",
  "return_sale",
  "create_customer",
  "edit_customer",
  "create_purchase_request",
];

for (const intent of OWNER_ONLY) {
  test(`companion/${intent}: isIntentAllowedForRole("companion") → false`, () => {
    assert.equal(
      isIntentAllowedForRole("companion", intent),
      false,
      `${intent} must be blocked for employee`
    );
  });

  test(`companion/${intent}: buildCompanionRefusal → warm message`, () => {
    const refusal = buildCompanionRefusal(intent);
    assertWarmRefusal(refusal, intent);
  });
}
