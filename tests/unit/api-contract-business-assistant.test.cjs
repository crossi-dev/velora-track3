"use strict";
// Contract test: POST /api/business-assistant response shape
// Verifies { answer: string, actions: CompoundAction[] } is always returned,
// actions is always a proper Array, and key sub-shapes hold across handler types.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  handleBusinessQuery,
} = require("../../src/app/api/business-assistant/_lib/intent-handlers/business-query.ts");

const BASE_CONTEXT = {
  business: { name: "Mi Negocio", type: null, currency: "ARS" },
  inventorySummary: { productLines: 2, totalUnits: 17, totalValue: 22000 },
  catalog: { products: [], customers: [], suppliers: [] },
  suppliers: [],
  salesStats: { today: { count: 0, totalAmount: 0 }, topProductsByUnitsSold: [] },
};

const PRODUCT_INFO = [
  { id: "p1", name: "Cemento", sku: null, price: 1500, stock: 12 },
];

function makeParams(overrides = {}) {
  return {
    text: "",
    locale: "es-AR",
    safeIntent: "business_query",
    answer: "Tenés 3 productos.",
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

// ── Shape invariants ───────────────────────────────────────────────────

test("business-assistant response always has answer (string) and actions (array)", async () => {
  const res = handleBusinessQuery(makeParams());
  const body = await res.json();
  assert.strictEqual(typeof body.answer, "string", "answer must be a string");
  assert.ok(Array.isArray(body.actions), "actions must be an Array");
});

test("business-assistant: answer is never null or undefined", async () => {
  for (const text of ["", "algo", "que tengo en stock", "quien me debe"]) {
    const res = handleBusinessQuery(makeParams({ text, answer: "respuesta" }));
    const body = await res.json();
    assert.ok(body.answer != null, `answer must not be null for text="${text}"`);
  }
});

test("business-assistant: actions is always an Array (never null, never object)", async () => {
  const cases = [
    makeParams({ text: "que hay" }),
    makeParams({ text: "cuanto stock de cemento", answer: "50 unidades" }),
    makeParams({ text: "quién me debe", context: { ...BASE_CONTEXT, pendingSales: [] } }),
  ];
  for (const params of cases) {
    const body = await handleBusinessQuery(params).json();
    assert.ok(Array.isArray(body.actions), "actions must be Array in all cases");
  }
});

test("business-assistant: no extra top-level keys beyond answer and actions", async () => {
  const body = await handleBusinessQuery(makeParams()).json();
  const keys = Object.keys(body);
  assert.ok(keys.includes("answer"), "must have answer key");
  assert.ok(keys.includes("actions"), "must have actions key");
  // Contract: no undocumented fields on the response root
  const unknown = keys.filter((k) => k !== "answer" && k !== "actions");
  assert.deepEqual(unknown, [], `unexpected top-level keys: ${unknown}`);
});

// ── Error shape contract ───────────────────────────────────────────────

test("business-assistant: non-matching intent returns null (caller handles fallthrough)", () => {
  const result = handleBusinessQuery(makeParams({ safeIntent: "register_sale" }));
  assert.strictEqual(result, null, "non-matching intent must return null, not a response");
});

// ── Answer passthrough fidelity ────────────────────────────────────────

test("business-assistant: answer passes through unchanged when no override applies", async () => {
  const original = "Hoy vendiste 5 productos por $12.000.";
  const body = await handleBusinessQuery(makeParams({
    text: "resumen de hoy",
    answer: original,
  })).json();
  assert.strictEqual(body.answer, original);
});

test("business-assistant: answer override replaces hallucinated stock with authoritative value", async () => {
  const body = await handleBusinessQuery(makeParams({
    text: "cuánto stock de cemento",
    answer: "Cemento tiene 9999 unidades",
  })).json();
  assert.match(body.answer, /12/, "authoritative stock (12) must appear in answer");
  assert.doesNotMatch(body.answer, /9999/, "hallucinated value must be gone");
});

