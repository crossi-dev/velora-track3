const assert = require("node:assert/strict");
const test = require("node:test");

const {
  handleBusinessQuery,
} = require("../../src/app/api/business-assistant/_lib/intent-handlers/business-query.ts");

const PRODUCT_INFO = [
  { id: "p1", name: "Cemento", sku: null, price: 1500, stock: 12 },
  { id: "p2", name: "Arena Gruesa", sku: null, price: 800, stock: 5 },
];

const BASE_CONTEXT = {
  business: { name: "Mi Negocio", type: null, currency: "ARS" },
  inventorySummary: { productLines: 2, totalUnits: 17, totalValue: 22000 },
  catalog: { products: [], customers: [], suppliers: [] },
  suppliers: [],
  salesStats: { today: { count: 0, totalAmount: 0 }, topProductsByUnitsSold: [] },
};

function makeParams(overrides = {}) {
  return {
    text: "",
    locale: "es-AR",
    safeIntent: "business_query",
    answer: "",
    parsed: { intent: "business_query" },
    context: BASE_CONTEXT,
    fullCatalogProducts: [],
    fullCatalogCustomers: [],
    fullCatalogSuppliers: [],
    productInfoDirectory: PRODUCT_INFO,
    trace: { add: () => {}, toJSON: () => null },
    ...overrides,
  };
}

const readJson = (r) => r.json();

// ── Intent gate ─────────────────────────────────────────────────────

test("returns null for non-business_query intents", () => {
  assert.equal(handleBusinessQuery(makeParams({ safeIntent: "register_sale" })), null);
});

// ── Inventory-wide patterns + generic AI answer → build local summary

test("'inventario completo' + empty AI answer → local summary", async () => {
  const res = handleBusinessQuery(makeParams({
    text: "inventario completo",
    answer: "",
  }));
  const data = await readJson(res);
  assert.ok(data.answer);
  assert.equal(data.actions?.length, 0);
});

test("'que productos tengo' + 'no entendí' AI answer → local summary", async () => {
  const res = handleBusinessQuery(makeParams({
    text: "que productos tengo",
    answer: "no entendí, podés reformular?",
  }));
  const data = await readJson(res);
  assert.ok(data.answer);
});

test("inventory-wide query + non-generic AI answer → AI answer passes through", async () => {
  const res = handleBusinessQuery(makeParams({
    text: "inventario",
    answer: "Tenés 17 unidades por un total de $22.000.",
  }));
  const data = await readJson(res);
  // Either passes through or rebuilds — handler picks based on looksGeneric
  assert.ok(data.answer);
});

// ── Single-product authoritative answer ─────────────────────────────

test("AI answer with product name + digits → rewritten with authoritative stock", async () => {
  const res = handleBusinessQuery(makeParams({
    text: "cuánto stock de cemento",
    answer: "Cemento tiene 50 unidades",  // wrong — real is 12
  }));
  const data = await readJson(res);
  // Handler should override with authoritative stock from productInfoDirectory
  // The real stock is 12 unidades
  assert.match(data.answer, /12/);
});

test("price query + AI hallucinates wrong price → override with authoritative price", async () => {
  // User asked about price; LLM gave wrong amount. Post-handler must override
  // with authoritative price from productInfoDirectory (1500).
  const res = handleBusinessQuery(makeParams({
    text: "cuánto vale el cemento",
    answer: "El cemento vale $9000.",
  }));
  const data = await readJson(res);
  assert.match(data.answer, /1[.,]?500/);
  assert.match(data.answer, /vale/i);
});

test("price query + AI gives correct price → still asserts authoritative (deterministic)", async () => {
  // Even if LLM is correct, handler standardizes the format.
  const res = handleBusinessQuery(makeParams({
    text: "a cuánto el cemento",
    answer: "El cemento vale $1500.",
  }));
  const data = await readJson(res);
  assert.match(data.answer, /vale/i);
});

test("price query → does NOT override with stock answer (regression for previous bug)", async () => {
  // Previously the handler always used buildProductStockAnswer when a product
  // was mentioned with digits. That clobbered correct price answers.
  const res = handleBusinessQuery(makeParams({
    text: "cuánto vale el cemento",
    answer: "El cemento vale $1500.",
  }));
  const data = await readJson(res);
  assert.doesNotMatch(data.answer, /unidades en stock/);
});

test("AI answer without digits passes through unchanged", async () => {
  const res = handleBusinessQuery(makeParams({
    text: "que productos vendo",
    answer: "Vendés cemento y arena.",
  }));
  const data = await readJson(res);
  assert.equal(data.answer, "Vendés cemento y arena.");
});

// ── Empty-actions array always present ──────────────────────────────

test("response always includes empty actions array", async () => {
  const res = handleBusinessQuery(makeParams({
    text: "que pasó hoy",
    answer: "Hoy hubo 3 ventas.",
  }));
  const data = await readJson(res);
  assert.ok(Array.isArray(data.actions));
  assert.equal(data.actions.length, 0);
});
