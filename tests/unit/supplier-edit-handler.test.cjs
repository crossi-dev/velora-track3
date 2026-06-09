const assert = require("node:assert/strict");
const test = require("node:test");

const {
  resolveSupplierEditRequest,
  extractSupplierEditFromRequest,
} = require("../../src/app/api/business-assistant/_lib/handlers/supplier-edit.ts");

const SUPPLIERS = [
  { id: "sup-1", name: "Aceros del Oeste" },
  { id: "sup-2", name: "Repuestos Norte" },
  { id: "sup-3", name: "Aceros del Sur" },
];

const EMPTY_PARSED = {};

// ── extractSupplierEditFromRequest (pure regex extraction) ────────────

test("extractSupplierEditFromRequest: parses 'cambiar el teléfono de X a Y' into { phone, X, Y }", () => {
  const r = extractSupplierEditFromRequest(
    "cambiar el teléfono de Aceros del Oeste a 2615551234"
  );
  assert.ok(r);
  assert.equal(r.field, "phone");
  assert.match(r.supplierName.toLowerCase(), /aceros del oeste/);
  assert.equal(r.value, "2615551234");
});

test("extractSupplierEditFromRequest: returns null when no field keyword is present", () => {
  const r = extractSupplierEditFromRequest("hola, cómo va");
  assert.equal(r, null);
});

// ── resolveSupplierEditRequest happy path ─────────────────────────────

test("resolveSupplierEditRequest: returns edit_supplier action when name + field + value are all unambiguous", () => {
  const text = "cambiar el teléfono de Aceros del Oeste a 2615551234";
  const result = resolveSupplierEditRequest(text, EMPTY_PARSED, SUPPLIERS, "es-AR");
  assert.ok(result.action);
  assert.equal(result.action.type, "edit_supplier");
  assert.equal(result.action.supplier.id, "sup-1");
  assert.equal(result.action.field, "phone");
  assert.equal(result.action.value, "2615551234");
});

// ── not found ─────────────────────────────────────────────────────────

test("resolveSupplierEditRequest: returns missing_supplier clarification when name doesn't match the catalog", () => {
  const text = "cambiar el teléfono de Empresa Inexistente a 2615551234";
  const result = resolveSupplierEditRequest(text, EMPTY_PARSED, SUPPLIERS, "es-AR");
  assert.ok(result.clarification);
  assert.match(result.clarification.answer, /qué proveedor querés editar/i);
  assert.ok(!("action" in result));
});

// ── critical edge: ambiguous match (two suppliers share a token prefix) ──

test("resolveSupplierEditRequest: returns ambiguous_supplier clarification when name matches multiple suppliers (substring tie)", () => {
  // "Aceros" is a substring of both "Aceros del Oeste" and "Aceros del Sur"
  // → both score 80 → tied within the 5-point ambiguity window.
  const text = "cambiar el teléfono de Aceros a 2615551234";
  const result = resolveSupplierEditRequest(text, EMPTY_PARSED, SUPPLIERS, "es-AR");
  assert.ok(result.clarification);
  assert.match(result.clarification.answer, /varios proveedores parecidos/i);
});

// ── critical edge: unsupported field (taxId not editable for supplier) ──

test("resolveSupplierEditRequest: rejects taxId edit with unsupported_field clarification (suppliers can't edit CUIT yet)", () => {
  const parsed = {
    supplier: { name: "Aceros del Oeste" },
    supplierEdit: { field: "taxId", value: "30-12345678-9" },
  };
  const result = resolveSupplierEditRequest("", parsed, SUPPLIERS, "es-AR");
  assert.ok(result.clarification);
  assert.match(result.clarification.answer, /todavía no está soportado/i);
});

// ── critical edge: invalid email format ───────────────────────────────

test("resolveSupplierEditRequest: rejects malformed email with invalid_email clarification", () => {
  const parsed = {
    supplier: { name: "Aceros del Oeste" },
    supplierEdit: { field: "email", value: "no-es-email" },
  };
  const result = resolveSupplierEditRequest("", parsed, SUPPLIERS, "es-AR");
  assert.ok(result.clarification);
  assert.match(result.clarification.answer, /correo electrónico no tiene un formato válido/i);
});
