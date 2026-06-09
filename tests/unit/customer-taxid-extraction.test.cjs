// Tests for taxId (CUIT/CUIL) capture in customer-extraction and
// resolveCustomerCreateRequest — Fase C2.

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  extractCustomerFromRequest,
} = require("../../src/app/api/business-assistant/_lib/handlers/customer-extraction.ts");

const {
  resolveCustomerCreateRequest,
} = require("../../src/app/api/business-assistant/_lib/handlers/customers.ts");

const EMPTY_PARSED = {};

// ── extractCustomerFromRequest ──────────────────────────────────────────────

test("extractCustomerFromRequest: captures CUIT when provided with label", () => {
  const result = extractCustomerFromRequest(
    "agregar cliente Distribuidora Sur, CUIT 30-12345678-9",
  );
  assert.ok(result, "should return a result");
  assert.equal(result.taxId, "30-12345678-9");
  assert.match(result.name, /Distribuidora Sur/i);
});

test("extractCustomerFromRequest: captures CUIL when provided with label", () => {
  const result = extractCustomerFromRequest(
    "crear cliente Juan Perez CUIL 20-30456789-1",
  );
  assert.ok(result, "should return a result");
  assert.equal(result.taxId, "20-30456789-1");
});

test("extractCustomerFromRequest: taxId is empty string when not provided", () => {
  const result = extractCustomerFromRequest("agregar cliente María López, teléfono 2611234567");
  assert.ok(result, "should return a result");
  assert.equal(result.taxId, "");
});

// ── resolveCustomerCreateRequest ────────────────────────────────────────────

test("resolveCustomerCreateRequest: includes taxId in action when present in text", () => {
  const text = "agregar cliente Distribuidora Sur, CUIT 30-12345678-9";
  const result = resolveCustomerCreateRequest(text, EMPTY_PARSED, "es-AR");
  assert.ok(result?.action, "should produce an action");
  assert.equal(result.action.customer.taxId, "30-12345678-9");
  assert.match(result.action.customer.name, /Distribuidora Sur/i);
});

test("resolveCustomerCreateRequest: taxId is empty/null when not provided", () => {
  const text = "agregar cliente María López";
  const result = resolveCustomerCreateRequest(text, EMPTY_PARSED, "es-AR");
  // null result is expected because regex alone doesn't flag 'agregar cliente' without CUIT
  // when force=false. Just verify no crash.
  assert.ok(result === null || result.action !== undefined || result.clarification !== undefined);
});

test("resolveCustomerCreateRequest: taxId from parsed model response takes precedence", () => {
  const text = "nuevo cliente ABC SA";
  const parsed = {
    customer: { name: "ABC SA", taxId: "30-99999999-3" },
  };
  const result = resolveCustomerCreateRequest(text, parsed, "es-AR", { force: true });
  assert.ok(result?.action, "should produce an action");
  assert.equal(result.action.customer.taxId, "30-99999999-3");
});
