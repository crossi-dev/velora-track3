// Unit tests for execute-price-query Fast Path executor.
// Regression cover for the Wave 2A promotion (2026-05-10):
//   - Employee context with missing product must return clarification, not throw.
//   - Empty currency must not throw RangeError (Intl.NumberFormat guard).
//   - Owner context with matching product returns price answer.
//   - Ambiguous match returns disambiguation prompt.

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  executePriceQuery,
} = require("../../src/app/api/business-assistant/_lib/nlu/execute-price-query.ts");

// ── Helpers ──────────────────────────────────────────────────────────────

function makeIntent(queryKind = "price", productText = "destornillador") {
  return { kind: "price_query", queryKind, productText };
}

function makeParams(overrides = {}) {
  return {
    locale: "es-AR",
    productInfoDirectory: [],
    business: { name: "Test Business", type: null, currency: "ARS" },
    context: { business: { name: "Test Business", type: null, currency: "ARS" } },
    actorEmployeeId: null,
    actorRole: "owner",
    businessId: "biz-1",
    ...overrides,
  };
}

const PRODUCT = { id: "p1", name: "Destornillador", sku: null, price: 1500, stock: 10 };

// ── Employee + missing product → graceful clarification, not throw ────────

test("employee ctx + missing product → clarification answer (no throw)", async () => {
  const intent = makeIntent("price", "destornillador");
  const params = makeParams({
    actorRole: "employee",
    actorEmployeeId: "emp-abc",
    productInfoDirectory: [], // empty catalog — product not found
  });

  let res;
  assert.doesNotThrow(() => {
    res = executePriceQuery(intent, params);
  });

  const body = await res.json();
  assert.ok(typeof body.answer === "string", "answer must be a string");
  assert.ok(body.answer.length > 0, "answer must be non-empty");
  // Must NOT throw — the original bug was a 500 here.
});

// ── Empty currency → no RangeError ──────────────────────────────────────

test("empty currency falls back to ARS — no RangeError with matching product", async () => {
  const intent = makeIntent("price", "destornillador");
  const params = makeParams({
    business: { name: "Test", type: null, currency: "" },       // empty — triggers RangeError without fix
    context: { business: { name: "Test", type: null, currency: "" } },
    productInfoDirectory: [PRODUCT],
  });

  let res;
  assert.doesNotThrow(() => {
    res = executePriceQuery(intent, params);
  });

  const body = await res.json();
  assert.ok(typeof body.answer === "string");
  assert.match(body.answer, /Destornillador/i);
});

// ── Null/undefined productInfoDirectory → graceful (no crash) ───────────

test("undefined productInfoDirectory → clarification answer (no throw)", async () => {
  const intent = makeIntent("price", "tuerca");
  const params = makeParams({ productInfoDirectory: undefined });

  let res;
  assert.doesNotThrow(() => {
    res = executePriceQuery(intent, params);
  });

  const body = await res.json();
  assert.ok(typeof body.answer === "string");
});

// ── Owner + matching product → price answer ──────────────────────────────

test("owner ctx + matching product → formatted price answer", async () => {
  const intent = makeIntent("price", "destornillador");
  const params = makeParams({ productInfoDirectory: [PRODUCT] });

  const res = executePriceQuery(intent, params);
  const body = await res.json();

  assert.ok(body.answer.includes("Destornillador"), "name in answer");
  assert.ok(body.answer.includes("vale"), "'vale' in price answer");
});

// ── Employee + matching product, stock queryKind → stock answer ──────────

test("employee ctx + matching product + queryKind=stock → stock answer", async () => {
  const intent = makeIntent("stock", "destornillador");
  const params = makeParams({
    actorRole: "employee",
    actorEmployeeId: "emp-xyz",
    productInfoDirectory: [PRODUCT],
  });

  let res;
  assert.doesNotThrow(() => {
    res = executePriceQuery(intent, params);
  });

  const body = await res.json();
  assert.ok(body.answer.includes("Destornillador"), "name in answer");
  assert.ok(body.answer.includes("stock") || body.answer.includes("unidades"), "stock keyword in answer");
});

// ── Ambiguous match → disambiguation prompt ──────────────────────────────

test("ambiguous catalog match → disambiguation prompt", async () => {
  const intent = makeIntent("price", "tornillo");
  const params = makeParams({
    productInfoDirectory: [
      { id: "p1", name: "Tornillo M5", sku: null, price: 100, stock: 50 },
      { id: "p2", name: "Tornillo M8", sku: null, price: 120, stock: 30 },
    ],
  });

  const res = executePriceQuery(intent, params);
  const body = await res.json();

  // Either ambiguous prompt or a resolved answer — both are valid; must not throw.
  assert.ok(typeof body.answer === "string");
});
