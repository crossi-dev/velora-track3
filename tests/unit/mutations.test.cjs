const assert = require("node:assert/strict");
const test = require("node:test");

const {
  normalizeCustomerName,
  normalizeCustomerNullableText,
} = require("../../src/infrastructure/shared/customer-mutations.ts");

const {
  normalizeSupplierName,
  normalizeSupplierLookupText,
  normalizeSupplierNullableText,
} = require("../../src/app/api/_lib/supplier-mutations.ts");

const {
  normalizeCashMovementDescription,
} = require("../../src/infrastructure/shared/cash-mutations.ts");

// ── Customer mutations ──

test("normalizeCustomerName: capitalizes each word", () => {
  assert.equal(normalizeCustomerName("juan pérez"), "Juan Pérez");
});

test("normalizeCustomerName: non-string returns empty", () => {
  assert.equal(normalizeCustomerName(null), "");
  assert.equal(normalizeCustomerName(123), "");
});

test("normalizeCustomerName: empty returns empty", () => {
  assert.equal(normalizeCustomerName("   "), "");
});

test("normalizeCustomerNullableText: returns trimmed", () => {
  assert.equal(normalizeCustomerNullableText("  hello  "), "hello");
});

test("normalizeCustomerNullableText: empty returns null", () => {
  assert.equal(normalizeCustomerNullableText(""), null);
  assert.equal(normalizeCustomerNullableText("   "), null);
});

test("normalizeCustomerNullableText: non-string returns null", () => {
  assert.equal(normalizeCustomerNullableText(42), null);
});

// ── Supplier mutations ──

test("normalizeSupplierName: capitalizes each word", () => {
  assert.equal(normalizeSupplierName("corralón norte"), "Corralón Norte");
});

test("normalizeSupplierName: non-string returns empty", () => {
  assert.equal(normalizeSupplierName(null), "");
});

test("normalizeSupplierLookupText: lowercase and strip accents", () => {
  assert.equal(normalizeSupplierLookupText("  Distribuidora SÚR  "), "distribuidora sur");
});

test("normalizeSupplierNullableText: trims value", () => {
  assert.equal(normalizeSupplierNullableText("  Pedro  "), "Pedro");
});

test("normalizeSupplierNullableText: empty returns null", () => {
  assert.equal(normalizeSupplierNullableText(""), null);
  assert.equal(normalizeSupplierNullableText(123), null);
});

// ── Cash movement mutations ──

test("normalizeCashMovementDescription: trims", () => {
  assert.equal(normalizeCashMovementDescription("  Alquiler local  "), "Alquiler local");
});

test("normalizeCashMovementDescription: non-string returns empty", () => {
  assert.equal(normalizeCashMovementDescription(null), "");
  assert.equal(normalizeCashMovementDescription(42), "");
});
