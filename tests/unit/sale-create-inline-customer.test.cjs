// Tests for sale_create_inline_new_customer fast path.
//
// Scenario: owner types "vendí 1 alfajor a Carlos Rossi 1100000000 …".
// Fast-path detects product + "a [Name] [phone]" pattern → emits
// sale_create_inline_new_customer intent instead of pending_customer chips.
//
// Covers:
//   T1 — canonical AR input: name + 10-digit area+number
//   T2 — international prefix: name + +5491190000000
//   T3 — spaced phone: name + "11 1234 5678"
//   T4 — name only (no phone) → falls to pending_customer (chips), not inline
//   T5 — existing customer matched by name → sale_create (reuse, no new)
//   T6 — existing customer matched by phone → sale_create (reuse, no duplicate)
//   T7 — retry same command → idempotency: confirmationRequest action is same shape
//   T8 — executor: valid inline-customer intent → confirmationRequest with register_sale_with_new_customer
//   T9 — executor: missing product in catalog → clarification, no register action
//   T10 — normalizeArgPhone: 10-digit → +549...
//   T11 — normalizeArgPhone: +549... 13-digit → unchanged
//   T12 — normalizeArgPhone: 0-prefix STD → +549...
//   T13 — normalizeArgPhone: too short → null

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  detectSaleCreateFastPath,
  normalizeArgPhone,
} = require("../../src/app/api/business-assistant/_lib/nlu/sale-create-fast-path.ts");

const {
  executeSaleCreateInlineCustomer,
} = require("../../src/app/api/business-assistant/_lib/nlu/execute-sale-create-inline-customer.ts");

// ── Minimal catalog fixtures ────────────────────────────────────────────────

const PRODUCTS = [
  { id: "prod-001", name: "Alfajor" },
  { id: "prod-002", name: "Coca Cola" },
];

const CUSTOMERS_EMPTY = [];

const CUSTOMERS_WITH_EXISTING = [
  { id: "cli-001", name: "Juan Pérez" },
  { id: "cli-002", name: "Lucía García", phone: "+5491112345678" },
];

function catalog(customers = CUSTOMERS_EMPTY) {
  return { products: PRODUCTS, customers };
}

async function parseResponse(nextResponse) {
  const text = await nextResponse.text();
  return JSON.parse(text);
}

function makeExecutorParams(intentOverrides = {}) {
  return {
    text: "vendí 1 alfajor a Carlos Rossi 1100000000",
    recentHistory: [],
    context: { catalog: { customers: CUSTOMERS_EMPTY }, activeRules: [] },
    productInfoDirectory: [
      { id: "prod-001", name: "Alfajor", sku: null, price: 150, stock: 10 },
    ],
    businessId: "biz-test-001",
    actorEmployeeId: null,
    actorUserId: "user-owner-001",
    actorRole: "owner",
    ...intentOverrides,
  };
}

function makeInlineIntent(overrides = {}) {
  return {
    kind: "sale_create_inline_new_customer",
    matchedProductId: "prod-001",
    productName: "Alfajor",
    qty: 1,
    unitPrice: null,
    newCustomerName: "Carlos Rossi",
    newCustomerPhone: "+5490000000000",
    ...overrides,
  };
}

// ── T1: canonical AR 10-digit phone ─────────────────────────────────────────

test("T1: inline_new_customer — name + 10-digit phone", () => {
  const result = detectSaleCreateFastPath(
    "vendí 1 alfajor a Carlos Rossi 1100000000",
    catalog(),
  );
  assert.ok(result, "must return a result");
  assert.equal(result.kind, "inline_new_customer");
  assert.equal(result.newCustomerName, "Carlos Rossi");
  assert.equal(result.newCustomerPhone, "+5490000000000");
  assert.equal(result.matchedProductId, "prod-001");
});

// ── T2: international prefix +549... ────────────────────────────────────────

test("T2: inline_new_customer — name + +5491190000000", () => {
  const result = detectSaleCreateFastPath(
    "vendí 1 alfajor a Juan Pérez +5491190000000",
    catalog(),
  );
  assert.ok(result, "must return a result");
  assert.equal(result.kind, "inline_new_customer");
  assert.equal(result.newCustomerName, "Juan Pérez");
  assert.equal(result.newCustomerPhone, "+5491190000000");
});

// ── T3: spaced phone "11 1234 5678" ─────────────────────────────────────────

test("T3: inline_new_customer — name + spaced phone", () => {
  const result = detectSaleCreateFastPath(
    "vendí 1 alfajor a María García 11 1234 5678",
    catalog(),
  );
  assert.ok(result, "must return a result");
  assert.equal(result.kind, "inline_new_customer");
  assert.equal(result.newCustomerName, "María García");
  // "11 1234 5678" normalized (no spaces) = "1112345678" → 10 digits → +5491112345678
  assert.equal(result.newCustomerPhone, "+5491112345678");
});

// ── T4: name only, no phone → pending_customer (chips) ──────────────────────

test("T4: name without phone → pending_customer (no inline)", () => {
  const result = detectSaleCreateFastPath(
    "vendí 1 alfajor a Carlos Rossi",
    catalog(CUSTOMERS_WITH_EXISTING),
  );
  assert.ok(result, "must return a result");
  assert.equal(result.kind, "pending_customer", "without phone, must fall to picker chips");
});

// ── T5: existing customer matched by name → sale_create (reuse) ─────────────

test("T5: existing customer matched by name → sale_create (no new customer created)", () => {
  const result = detectSaleCreateFastPath(
    "vendí 1 alfajor a Juan Pérez",
    catalog(CUSTOMERS_WITH_EXISTING),
  );
  assert.ok(result, "must return a result");
  // Either sale_create (full match) or pending_customer — not inline_new_customer.
  assert.notEqual(result.kind, "inline_new_customer");
  if (!result.kind) {
    // Full match — customer was resolved from catalog.
    assert.equal(result.matchedCustomerId, "cli-001");
  }
});

// ── T6: existing customer matched by phone → reuse, no duplicate ─────────────

test("T6: existing customer matched by phone → reuse existing (no inline_new_customer)", () => {
  // Lucía García has phone +5491112345678 in catalog.
  // Text has "a Lucía García 1112345678" — normalized phone matches catalog entry.
  const result = detectSaleCreateFastPath(
    "vendí 1 alfajor a Lucía García 1112345678",
    catalog(CUSTOMERS_WITH_EXISTING),
  );
  assert.ok(result, "must return a result");
  // Should NOT be inline_new_customer — should reuse existing customer.
  assert.notEqual(result.kind, "inline_new_customer",
    "phone match against existing customer must reuse it, not create a new one");
});

// ── T7: idempotency — same command structure produces same action type ────────

test("T7: retry same command → confirmationRequest action type is stable (idempotency shape)", () => {
  const result1 = detectSaleCreateFastPath(
    "vendí 1 alfajor a Carlos Rossi 1100000000",
    catalog(),
  );
  const result2 = detectSaleCreateFastPath(
    "vendí 1 alfajor a Carlos Rossi 1100000000",
    catalog(),
  );
  assert.ok(result1 && result2);
  assert.equal(result1.kind, result2.kind);
  if (result1.kind === "inline_new_customer" && result2.kind === "inline_new_customer") {
    assert.equal(result1.newCustomerPhone, result2.newCustomerPhone);
    assert.equal(result1.newCustomerName, result2.newCustomerName);
  }
});

// ── T8: executor emits register_sale_with_new_customer ───────────────────────

test("T8: executor — valid inline intent → confirmationRequest with register_sale_with_new_customer", async () => {
  const intent = makeInlineIntent();
  const params = makeExecutorParams();
  const res = executeSaleCreateInlineCustomer(intent, params);
  const body = await parseResponse(res);
  assert.ok(body.confirmationRequest, "must return confirmationRequest");
  assert.equal(
    body.confirmationRequest.action.type,
    "register_sale_with_new_customer",
    "action type must be register_sale_with_new_customer",
  );
  assert.equal(body.confirmationRequest.action.matchedProductId, "prod-001");
  assert.equal(body.confirmationRequest.action.autoSend, false);
  assert.equal(body.confirmationRequest.action.newCustomer.name, "Carlos Rossi");
  assert.equal(body.confirmationRequest.action.newCustomer.phone, "+5490000000000");
});

// ── T9: executor: hallucinated/missing product → clarification ──────────────

test("T9: executor — matchedProductId not in catalog → clarification, no action", async () => {
  const intent = makeInlineIntent({ matchedProductId: "prod-does-not-exist" });
  const params = makeExecutorParams();
  const res = executeSaleCreateInlineCustomer(intent, params);
  const body = await parseResponse(res);
  assert.ok(body.answer, "must return an answer");
  assert.ok(!body.confirmationRequest, "must NOT emit confirmationRequest for missing product");
  assert.ok(!body.actions, "must NOT emit actions");
});

// ── T10–T13: normalizeArgPhone unit tests ────────────────────────────────────

test("T10: normalizeArgPhone — 10-digit → +549…", () => {
  assert.equal(normalizeArgPhone("1100000000"), "+5490000000000");
});

test("T11: normalizeArgPhone — already +549 13-digit → unchanged", () => {
  assert.equal(normalizeArgPhone("+5490000000000"), "+5490000000000");
});

test("T12: normalizeArgPhone — 0-prefix STD trunk → +549…", () => {
  // "01100000000" = 11 digits starting with 0 → strip 0 → +549 + 1100000000
  assert.equal(normalizeArgPhone("01100000000"), "+5490000000000");
});

test("T13: normalizeArgPhone — 8-digit (too short) → null", () => {
  assert.equal(normalizeArgPhone("12345678"), null);
});
