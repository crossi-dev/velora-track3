/**
 * handler-delete-customer.test.cjs
 *
 * Verifica el wiring completo de delete_customer:
 *
 *   1. mapSupervisorActionsToCompoundActions detecta delete_customer y
 *      resuelve el cliente por nombre (diacritic-tolerant).
 *   2. mapSupervisorActionsToCompoundActions retorna null cuando el cliente
 *      no existe en el snapshot (not_found guard).
 *   3. handleDeleteCustomer (intent handler) emite una confirmation card
 *      para un cliente conocido.
 *   4. handleDeleteCustomer retorna una pregunta cuando el nombre está vacío.
 *   5. handleDeleteCustomer retorna null para intents que no son delete_customer.
 *   6. looksLikeDeleteCustomer detecta frases destructivas con "cliente".
 *   7. El detector NO dispara para delete_supplier (false positive guard).
 */

"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  mapSupervisorActionsToCompoundActions,
} = require("../../src/app/api/business-assistant/_lib/supervisor-action-mapper.ts");

const {
  handleDeleteCustomer,
} = require("../../src/app/api/business-assistant/_lib/intent-handlers/customer.ts");

const {
  looksLikeDeleteCustomer,
} = require("../../src/app/api/business-assistant/_lib/handlers/owner-only-detectors.ts");

// ── fixtures ──────────────────────────────────────────────────────────────────

const CUSTOMERS = [
  { id: "c1", name: "Juan Pérez" },
  { id: "c2", name: "María García" },
];
const PRODUCTS = [];
const SUPPLIERS = [];

function makeAction(data) {
  return { intent: "delete_customer", data, summary: "del" };
}

function makeParams(overrides = {}) {
  return {
    text: "",
    locale: "es-AR",
    safeIntent: "delete_customer",
    answer: "Procesando.",
    parsed: { intent: "delete_customer", customer: null },
    context: {},
    fullCatalogProducts: PRODUCTS,
    fullCatalogCustomers: CUSTOMERS,
    fullCatalogSuppliers: SUPPLIERS,
    productInfoDirectory: [],
    trace: { add: () => {}, toJSON: () => null },
    ...overrides,
  };
}

// ── mapper tests ──────────────────────────────────────────────────────────────

test("mapSupervisorActionsToCompoundActions: delete_customer → resolved CompoundAction", () => {
  const actions = mapSupervisorActionsToCompoundActions(
    [makeAction({ customerName: "Juan Pérez" })],
    PRODUCTS,
    CUSTOMERS,
    SUPPLIERS,
  );
  assert.equal(actions.length, 1, "expected one mapped action");
  assert.equal(actions[0].type, "delete_customer");
  assert.equal(actions[0].customer.id, "c1");
  assert.equal(actions[0].customer.name, "Juan Pérez");
});

test("mapSupervisorActionsToCompoundActions: delete_customer with diacritic variation → resolved", () => {
  // "Juan Perez" (no accent) should still resolve to "Juan Pérez"
  const actions = mapSupervisorActionsToCompoundActions(
    [makeAction({ customerName: "Juan Perez" })],
    PRODUCTS,
    CUSTOMERS,
    SUPPLIERS,
  );
  assert.equal(actions.length, 1, "expected one mapped action despite diacritic mismatch");
  assert.equal(actions[0].customer.id, "c1");
});

test("mapSupervisorActionsToCompoundActions: delete_customer not_found → returns null (suppressed)", () => {
  // Customer not in snapshot → mapper suppresses the action (returns null internally,
  // filtered from the result array) to prevent an empty id reaching DELETE /api/customers.
  const actions = mapSupervisorActionsToCompoundActions(
    [makeAction({ customerName: "Cliente Inexistente" })],
    PRODUCTS,
    CUSTOMERS,
    SUPPLIERS,
  );
  assert.equal(actions.length, 0, "expected no actions — not_found guard must suppress");
});

// ── handler tests ─────────────────────────────────────────────────────────────

test("handleDeleteCustomer: returns null for non-delete_customer intent", () => {
  const result = handleDeleteCustomer(makeParams({ safeIntent: "create_customer" }));
  assert.equal(result, null);
});

test("handleDeleteCustomer: missing customer name → clarification question", async () => {
  const result = handleDeleteCustomer(makeParams({
    parsed: { intent: "delete_customer", customer: null },
  }));
  assert.ok(result && typeof result.json === "function", "expected NextResponse");
  const data = await result.json();
  assert.ok(typeof data.answer === "string" && data.answer.length > 0, "should ask for name");
});

test("handleDeleteCustomer: known customer → confirmation card", async () => {
  const result = handleDeleteCustomer(makeParams({
    parsed: { intent: "delete_customer", customer: { name: "Juan Pérez" } },
  }));
  assert.ok(result && typeof result.json === "function", "expected NextResponse with confirmation card");
  const data = await result.json();
  assert.ok(data.confirmationRequest, "should emit confirmationRequest");
  assert.equal(data.confirmationRequest.action.type, "delete_customer");
  assert.equal(data.confirmationRequest.action.customer.id, "c1");
  assert.equal(data.confirmationRequest.severity, "critical");
});

test("handleDeleteCustomer: unknown customer → not_found warm message", async () => {
  const result = handleDeleteCustomer(makeParams({
    parsed: { intent: "delete_customer", customer: { name: "Nadie Nadie" } },
  }));
  assert.ok(result && typeof result.json === "function", "expected NextResponse");
  const data = await result.json();
  assert.ok(typeof data.answer === "string" && data.answer.length > 0, "should surface warm not-found message");
  assert.ok(!data.confirmationRequest, "must NOT emit confirmation for unknown customer");
});

test("handleDeleteCustomer: diacritic-tolerant lookup → confirmation card", async () => {
  // "Maria Garcia" (no accents) should resolve to "María García" in the catalog.
  const result = handleDeleteCustomer(makeParams({
    parsed: { intent: "delete_customer", customer: { name: "Maria Garcia" } },
  }));
  assert.ok(result && typeof result.json === "function", "expected NextResponse");
  const data = await result.json();
  assert.ok(data.confirmationRequest, "diacritic-tolerant lookup should succeed");
  assert.equal(data.confirmationRequest.action.customer.id, "c2");
});

// ── detector tests ────────────────────────────────────────────────────────────

test("looksLikeDeleteCustomer: 'borrar cliente Juan Pérez' → true", () => {
  assert.equal(looksLikeDeleteCustomer("borrar cliente Juan Pérez"), true);
});

test("looksLikeDeleteCustomer: 'eliminar cliente' → true", () => {
  assert.equal(looksLikeDeleteCustomer("eliminar cliente"), true);
});

test("looksLikeDeleteCustomer: 'borrá al cliente María' → true", () => {
  assert.equal(looksLikeDeleteCustomer("borrá al cliente María"), true);
});

test("looksLikeDeleteCustomer: 'borrar proveedor ABC' → false (supplier, not customer)", () => {
  assert.equal(looksLikeDeleteCustomer("borrar proveedor ABC"), false);
});

test("looksLikeDeleteCustomer: 'agregar cliente Juan' → false (no delete verb)", () => {
  assert.equal(looksLikeDeleteCustomer("agregar cliente Juan"), false);
});

test("looksLikeDeleteCustomer: 'borrar producto tuerca' → false (no customer noun)", () => {
  assert.equal(looksLikeDeleteCustomer("borrar producto tuerca"), false);
});
