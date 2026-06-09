const assert = require("node:assert/strict");
const test = require("node:test");

const {
  resolveCustomerEditRequest,
} = require("../../src/app/api/business-assistant/_lib/handlers/customer-edit-resolve.ts");

const CUSTOMERS = [
  { id: "cust-1", name: "Juan Pérez" },
  { id: "cust-2", name: "María López" },
  { id: "cust-3", name: "Juan Carlos Pérez" },
];

const EMPTY_PARSED = {};

// ── happy path ────────────────────────────────────────────────────────

test("resolveCustomerEditRequest: returns edit_customer action when name + field + value are all unambiguous", () => {
  const text = "cambiar el teléfono de María López a 2615559999";
  const result = resolveCustomerEditRequest(text, EMPTY_PARSED, CUSTOMERS, "es-AR");
  assert.ok(result.action);
  assert.equal(result.action.type, "edit_customer");
  assert.equal(result.action.customer.id, "cust-2");
  assert.equal(result.action.field, "phone");
  assert.equal(result.action.value, "2615559999");
});

// ── not found ─────────────────────────────────────────────────────────

test("resolveCustomerEditRequest: returns missing_customer clarification when name doesn't match the catalog", () => {
  const parsed = {
    customer: { name: "Cliente Que No Existe" },
    customerEdit: { field: "phone", value: "2615551234" },
  };
  const result = resolveCustomerEditRequest("", parsed, CUSTOMERS, "es-AR");
  assert.ok(result.clarification);
  assert.match(result.clarification.answer, /qué cliente querés editar/i);
  assert.ok(!("action" in result));
});

// ── critical edge: ambiguous match (shared substring across two customers) ──

test("resolveCustomerEditRequest: returns ambiguous_customer clarification when name matches multiple customers", () => {
  // "Juan" is a substring of both "Juan Pérez" and "Juan Carlos Pérez" → tied
  const parsed = {
    customer: { name: "Juan" },
    customerEdit: { field: "phone", value: "2615551234" },
  };
  const result = resolveCustomerEditRequest("", parsed, CUSTOMERS, "es-AR");
  assert.ok(result.clarification);
  assert.match(result.clarification.answer, /varios clientes parecidos/i);
});

// ── critical edge: unsupported field (address / notes not editable yet) ──

test("resolveCustomerEditRequest: rejects address edit with unsupported_field clarification", () => {
  const parsed = {
    customer: { name: "Juan Pérez" },
    customerEdit: { field: "address", value: "Calle Falsa 123" },
  };
  const result = resolveCustomerEditRequest("", parsed, CUSTOMERS, "es-AR");
  assert.ok(result.clarification);
  assert.match(result.clarification.answer, /todavía no están soportadas/i);
});

// ── critical edge: weak name value rejected ───────────────────────────

test("resolveCustomerEditRequest: rejects rename to a weak/empty value with missing_value clarification", () => {
  const parsed = {
    customer: { name: "Juan Pérez" },
    customerEdit: { field: "name", value: "cliente" },
  };
  const result = resolveCustomerEditRequest("", parsed, CUSTOMERS, "es-AR");
  assert.ok(result.clarification);
  assert.match(result.clarification.answer, /nuevo valor/i);
});
