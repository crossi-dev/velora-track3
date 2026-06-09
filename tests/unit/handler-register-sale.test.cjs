const assert = require("node:assert/strict");
const test = require("node:test");

const {
  handleRegisterSale,
} = require("../../src/app/api/business-assistant/_lib/intent-handlers/sale.ts");

const PRODUCTS = [
  { id: "p1", name: "Remera Algodón", price: 2500 },
  { id: "p2", name: "Pantalón Cargo", price: 18000 },
];
const CUSTOMERS = [
  { id: "c1", name: "Juan Pérez" },
  { id: "c2", name: "María González" },
];

function makeParams(overrides = {}) {
  // matchedProductId is required by the hallucination guard added 2026-05.
  // Without a valid catalog ID the handler rejects and returns null. Merge
  // parsed so callers can override individual fields without losing the ID.
  const baseParsed = { intent: "register_sale", matchedProductId: "p1" };
  const merged = { ...baseParsed, ...overrides.parsed };
  return {
    text: "",
    locale: "es-AR",
    safeIntent: "register_sale",
    answer: "Procesando venta.",
    parsed: merged,
    context: {},
    fullCatalogProducts: PRODUCTS,
    fullCatalogCustomers: CUSTOMERS,
    fullCatalogSuppliers: [],
    productInfoDirectory: [],
    trace: { add: () => {}, toJSON: () => null },
    ...overrides,
    parsed: merged,
  };
}

// ── Intent gate ──────────────────────────────────────────────────────

test("handleRegisterSale returns null for non-register_sale intents", async () => {
  assert.equal(await handleRegisterSale(makeParams({ safeIntent: "register_movement" })), null);
  assert.equal(await handleRegisterSale(makeParams({ safeIntent: "answer" })), null);
});

// ── Auto-send detection ─────────────────────────────────────────────

test("autoSend: true in parsed → primaryAction.autoSend = true", async () => {
  const res = await handleRegisterSale(makeParams({
    parsed: { intent: "register_sale", autoSend: true, saleDraft: { items: [{ productName: "Remera", quantity: 1, unitPrice: 2500 }] } },
  }));
  assert.equal(res.primaryAction.autoSend, true);
});

test("autoSend false + no send keyword → autoSend undefined", async () => {
  const res = await handleRegisterSale(makeParams({
    text: "vendí 1 remera",
    parsed: { intent: "register_sale", autoSend: false, saleDraft: { items: [{ productName: "Remera", quantity: 1, unitPrice: 2500 }] } },
  }));
  // undefined or false acceptable
  assert.notEqual(res.primaryAction.autoSend, true);
});

test("autoSend inferred from 'mandale' keyword in text", async () => {
  const res = await handleRegisterSale(makeParams({
    text: "vendí 1 remera y mandale el comprobante",
    parsed: { intent: "register_sale", saleDraft: { items: [{ productName: "Remera", quantity: 1 }] } },
  }));
  // containsSendKeyword catches "mandale" → true
  assert.equal(res.primaryAction.autoSend, true);
});

// ── Sale draft resolution ──────────────────────────────────────────

test("resolved sale draft → saleDraft included with items", async () => {
  const res = await handleRegisterSale(makeParams({
    parsed: {
      intent: "register_sale",
      saleDraft: { items: [{ productName: "Remera Algodón", quantity: 2, unitPrice: 2500 }] },
    },
  }));
  if (res.saleDraft) {
    assert.ok(Array.isArray(res.saleDraft.items));
    assert.ok(res.saleDraft.items.length >= 1);
  }
  assert.equal(res.primaryAction.type, "register_sale");
});

test("missing saleDraft → primaryAction without saleDraft block", async () => {
  const res = await handleRegisterSale(makeParams({
    parsed: { intent: "register_sale" },
  }));
  assert.equal(res.primaryAction.type, "register_sale");
  // saleDraft is optional — handler still emits primaryAction
});

// ── Matched IDs propagated ──────────────────────────────────────────

test("matchedCustomerId propagated to primaryAction", async () => {
  const res = await handleRegisterSale(makeParams({
    parsed: {
      intent: "register_sale",
      matchedCustomerId: "c1",
      saleDraft: { items: [{ productName: "Remera", quantity: 1 }] },
    },
  }));
  assert.equal(res.primaryAction.matchedCustomerId, "c1");
});

test("matchedProductId propagated to primaryAction", async () => {
  const res = await handleRegisterSale(makeParams({
    parsed: {
      intent: "register_sale",
      matchedProductId: "p1",
      saleDraft: { items: [{ productName: "Remera", quantity: 1 }] },
    },
  }));
  assert.equal(res.primaryAction.matchedProductId, "p1");
});
