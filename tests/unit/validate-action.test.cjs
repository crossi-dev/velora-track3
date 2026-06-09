const assert = require("node:assert/strict");
const test = require("node:test");

const {
  validateParsedAction,
} = require("../../src/app/api/business-assistant/_lib/validate-action.ts");

// ── register_sale ────────────────────────────────────────────────────

test("register_sale: rejects payload with no items, no match, no name", () => {
  const r = validateParsedAction("register_sale", {});
  assert.equal(r.valid, false);
  assert.equal(r.reason, "missing_sale_target");
});

test("register_sale: accepts saleDraft with items", () => {
  const r = validateParsedAction("register_sale", {
    saleDraft: { items: [{ productName: "remera", quantity: 3, unitPrice: 2500 }] },
  });
  assert.equal(r.valid, true);
});

test("register_sale: accepts matchedProductId", () => {
  const r = validateParsedAction("register_sale", { matchedProductId: "p1" });
  assert.equal(r.valid, true);
});

test("register_sale: accepts product.name fallback", () => {
  const r = validateParsedAction("register_sale", { product: { name: "remera" } });
  assert.equal(r.valid, true);
});

test("register_sale: rejects empty-string product names in items", () => {
  const r = validateParsedAction("register_sale", {
    saleDraft: { items: [{ productName: "", quantity: 1, unitPrice: 100 }] },
  });
  assert.equal(r.valid, false);
});

// ── delete_product ───────────────────────────────────────────────────

test("delete_product: rejects empty payload", () => {
  const r = validateParsedAction("delete_product", {});
  assert.equal(r.valid, false);
  assert.equal(r.reason, "missing_delete_target");
});

test("delete_product: accepts productDeletes array", () => {
  const r = validateParsedAction("delete_product", {
    productDeletes: [{ productName: "clavo" }],
  });
  assert.equal(r.valid, true);
});

test("delete_product: accepts product.name fallback", () => {
  const r = validateParsedAction("delete_product", { product: { name: "clavo" } });
  assert.equal(r.valid, true);
});

test("delete_product: accepts matchedProductId", () => {
  const r = validateParsedAction("delete_product", { matchedProductId: "p1" });
  assert.equal(r.valid, true);
});

// ── bulk_price_update ────────────────────────────────────────────────

test("bulk_price_update: rejects missing fields", () => {
  const r = validateParsedAction("bulk_price_update", {});
  assert.equal(r.valid, false);
  assert.equal(r.reason, "missing_bulk_price_data");
});

test("bulk_price_update: rejects amount of zero", () => {
  const r = validateParsedAction("bulk_price_update", {
    bulkPriceUpdate: { amount: 0, mode: "percentage", direction: "up", target: "all" },
  });
  assert.equal(r.valid, false);
});

test("bulk_price_update: rejects negative amount", () => {
  const r = validateParsedAction("bulk_price_update", {
    bulkPriceUpdate: { amount: -10, mode: "percentage", direction: "up", target: "all" },
  });
  assert.equal(r.valid, false);
});

test("bulk_price_update: accepts complete payload", () => {
  const r = validateParsedAction("bulk_price_update", {
    bulkPriceUpdate: { amount: 10, mode: "percentage", direction: "up", target: "all" },
  });
  assert.equal(r.valid, true);
});

test("bulk_price_update: rejects when mode is missing", () => {
  const r = validateParsedAction("bulk_price_update", {
    bulkPriceUpdate: { amount: 10, mode: null, direction: "up", target: "all" },
  });
  assert.equal(r.valid, false);
});

// ── edit_customer ────────────────────────────────────────────────────

test("edit_customer: rejects without target", () => {
  const r = validateParsedAction("edit_customer", {});
  assert.equal(r.valid, false);
  assert.equal(r.reason, "missing_customer_target");
});

test("edit_customer: accepts matchedCustomerId", () => {
  const r = validateParsedAction("edit_customer", { matchedCustomerId: "c1" });
  assert.equal(r.valid, true);
});

test("edit_customer: accepts customer.name", () => {
  const r = validateParsedAction("edit_customer", { customer: { name: "Juan" } });
  assert.equal(r.valid, true);
});

// ── edit_supplier ────────────────────────────────────────────────────

test("edit_supplier: rejects without target", () => {
  const r = validateParsedAction("edit_supplier", {});
  assert.equal(r.valid, false);
  assert.equal(r.reason, "missing_supplier_target");
});

test("edit_supplier: accepts supplier.name", () => {
  const r = validateParsedAction("edit_supplier", { supplier: { name: "Distri ABC" } });
  assert.equal(r.valid, true);
});

// ── stock_load (numeric hardening) ────────────────────────────────────

test("stock_load: rejects single draft with zero quantity", () => {
  const r = validateParsedAction("stock_load", {
    stockDraft: { itemName: "clavo", quantity: 0 },
  });
  assert.equal(r.valid, false);
  assert.equal(r.reason, "invalid_stock_quantity");
});

test("stock_load: rejects single draft with NaN-string quantity", () => {
  const r = validateParsedAction("stock_load", {
    stockDraft: { itemName: "clavo", quantity: "abc" },
  });
  assert.equal(r.valid, false);
});

test("stock_load: rejects multi draft with negative quantity", () => {
  const r = validateParsedAction("stock_load", {
    stockDrafts: [{ itemName: "clavo", quantity: -5 }],
  });
  assert.equal(r.valid, false);
});

test("stock_load: accepts valid numeric quantity", () => {
  const r = validateParsedAction("stock_load", {
    stockDraft: { itemName: "clavo", quantity: 50, unitPrice: 200 },
  });
  assert.equal(r.valid, true);
});

test("stock_load: accepts numeric string quantity", () => {
  const r = validateParsedAction("stock_load", {
    stockDraft: { itemName: "clavo", quantity: "50" },
  });
  assert.equal(r.valid, true);
});

// ── existing intents (regression) ────────────────────────────────────

test("register_movement: rejects payload missing amount", () => {
  const r = validateParsedAction("register_movement", {
    movementDraft: { movementType: "gasto", description: "luz" },
  });
  assert.equal(r.valid, false);
});

test("create_customer: rejects completely empty customer (no identifying field)", () => {
  const r = validateParsedAction("create_customer", { customer: { name: "" } });
  assert.equal(r.valid, false);
});

test("create_customer: accepts phone-only (no name required)", () => {
  const r = validateParsedAction("create_customer", { customer: { phone: "1100000000" } });
  assert.equal(r.valid, true);
});

test("create_customer: accepts name + phone (Juan scenario)", () => {
  const r = validateParsedAction("create_customer", { customer: { name: "Carlos Rossi", phone: "1100000000" } });
  assert.equal(r.valid, true);
});

test("answer: always passes", () => {
  const r = validateParsedAction("answer", {});
  assert.equal(r.valid, true);
});
