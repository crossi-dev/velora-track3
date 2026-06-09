const assert = require("node:assert/strict");
const test = require("node:test");

const {
  EMPLOYEE_DESTRUCTIVE_INTENTS,
  canEmployeeExecuteIntent,
  rbacGuard,
} = require("../../src/app/api/business-assistant/_lib/rbac-policy.ts");

// ── EMPLOYEE_DESTRUCTIVE_INTENTS — lista canónica del Brief ───────────

test("EMPLOYEE_DESTRUCTIVE_INTENTS: incluye edit_product", () => {
  assert.equal(EMPLOYEE_DESTRUCTIVE_INTENTS.has("edit_product"), true);
});

test("EMPLOYEE_DESTRUCTIVE_INTENTS: incluye delete_product", () => {
  assert.equal(EMPLOYEE_DESTRUCTIVE_INTENTS.has("delete_product"), true);
});

test("EMPLOYEE_DESTRUCTIVE_INTENTS: incluye bulk_price_update", () => {
  assert.equal(EMPLOYEE_DESTRUCTIVE_INTENTS.has("bulk_price_update"), true);
});

test("EMPLOYEE_DESTRUCTIVE_INTENTS: incluye create_supplier", () => {
  assert.equal(EMPLOYEE_DESTRUCTIVE_INTENTS.has("create_supplier"), true);
});

test("EMPLOYEE_DESTRUCTIVE_INTENTS: incluye edit_supplier", () => {
  assert.equal(EMPLOYEE_DESTRUCTIVE_INTENTS.has("edit_supplier"), true);
});

test("EMPLOYEE_DESTRUCTIVE_INTENTS: incluye create_customer (owner-only por contrato canónico)", () => {
  // Pre-2026-05-09 esto estaba marcado como permitido al empleado por una nota
  // sobre el "flujo de venta" — contradecía role-contract OWNER_ONLY_INTENTS.
  assert.equal(EMPLOYEE_DESTRUCTIVE_INTENTS.has("create_customer"), true);
});

test("EMPLOYEE_DESTRUCTIVE_INTENTS: incluye edit_customer (owner-only por contrato canónico)", () => {
  // Pre-2026-05-09 esto estaba marcado como permitido al empleado por una nota
  // sobre "corrección de datos en venta" — contradecía role-contract.
  assert.equal(EMPLOYEE_DESTRUCTIVE_INTENTS.has("edit_customer"), true);
});

test("EMPLOYEE_DESTRUCTIVE_INTENTS: NO incluye stock_load (pasa por A2A supervisor intercept)", () => {
  assert.equal(EMPLOYEE_DESTRUCTIVE_INTENTS.has("stock_load"), false);
});

test("EMPLOYEE_DESTRUCTIVE_INTENTS: incluye adjust_stock", () => {
  assert.equal(EMPLOYEE_DESTRUCTIVE_INTENTS.has("adjust_stock"), true);
});

test("EMPLOYEE_DESTRUCTIVE_INTENTS: incluye stock_adjustment", () => {
  assert.equal(EMPLOYEE_DESTRUCTIVE_INTENTS.has("stock_adjustment"), true);
});

test("EMPLOYEE_DESTRUCTIVE_INTENTS: incluye register_movement", () => {
  assert.equal(EMPLOYEE_DESTRUCTIVE_INTENTS.has("register_movement"), true);
});

test("EMPLOYEE_DESTRUCTIVE_INTENTS: NO incluye register_sale (core del rol cashier)", () => {
  assert.equal(EMPLOYEE_DESTRUCTIVE_INTENTS.has("register_sale"), false);
});

test("EMPLOYEE_DESTRUCTIVE_INTENTS: NO incluye business_query (read-only)", () => {
  assert.equal(EMPLOYEE_DESTRUCTIVE_INTENTS.has("business_query"), false);
});

test("EMPLOYEE_DESTRUCTIVE_INTENTS: NO incluye check_stock (read-only, resuelto client-side)", () => {
  // check_stock vive en el Command Layer del dashboard y nunca llega al RBAC
  // server-side. No está en OWNER_ONLY_INTENTS — está fuera del set canónico.
  assert.equal(EMPLOYEE_DESTRUCTIVE_INTENTS.has("check_stock"), false);
});

test("EMPLOYEE_DESTRUCTIVE_INTENTS: NO incluye answer (chat conversacional)", () => {
  assert.equal(EMPLOYEE_DESTRUCTIVE_INTENTS.has("answer"), false);
});

// ── canEmployeeExecuteIntent ──────────────────────────────────────────

test("canEmployeeExecuteIntent: register_sale → true", () => {
  assert.equal(canEmployeeExecuteIntent("register_sale"), true);
});

test("canEmployeeExecuteIntent: business_query → true", () => {
  assert.equal(canEmployeeExecuteIntent("business_query"), true);
});

test("canEmployeeExecuteIntent: answer → true", () => {
  assert.equal(canEmployeeExecuteIntent("answer"), true);
});

test("canEmployeeExecuteIntent: check_stock → false (no está en allowlist canónica; se resuelve client-side)", () => {
  // check_stock vive en el Command Layer del dashboard. Si por alguna razón
  // un payload llegara al server-side rbac con ese intent, fail-closed.
  assert.equal(canEmployeeExecuteIntent("check_stock"), false);
});

test("canEmployeeExecuteIntent: edit_product → false", () => {
  assert.equal(canEmployeeExecuteIntent("edit_product"), false);
});

test("canEmployeeExecuteIntent: delete_product → false", () => {
  assert.equal(canEmployeeExecuteIntent("delete_product"), false);
});

test("canEmployeeExecuteIntent: bulk_price_update → false", () => {
  assert.equal(canEmployeeExecuteIntent("bulk_price_update"), false);
});

test("canEmployeeExecuteIntent: stock_load → true (pasa por A2A supervisor intercept)", () => {
  assert.equal(canEmployeeExecuteIntent("stock_load"), true);
});

test("canEmployeeExecuteIntent: adjust_stock → false", () => {
  assert.equal(canEmployeeExecuteIntent("adjust_stock"), false);
});

test("canEmployeeExecuteIntent: register_movement → false", () => {
  assert.equal(canEmployeeExecuteIntent("register_movement"), false);
});

test("canEmployeeExecuteIntent: create_supplier → false", () => {
  assert.equal(canEmployeeExecuteIntent("create_supplier"), false);
});

test("canEmployeeExecuteIntent: edit_supplier → false", () => {
  assert.equal(canEmployeeExecuteIntent("edit_supplier"), false);
});

test("canEmployeeExecuteIntent: create_customer → false (owner-only por contrato canónico)", () => {
  assert.equal(canEmployeeExecuteIntent("create_customer"), false);
});

test("canEmployeeExecuteIntent: edit_customer → false (owner-only por contrato canónico)", () => {
  assert.equal(canEmployeeExecuteIntent("edit_customer"), false);
});

test("canEmployeeExecuteIntent: intent desconocido → false (fail-closed; allowlist canónica)", () => {
  // El contrato canónico (role-contract.ts EMPLOYEE_ALLOWED_INTENTS) es una
  // allowlist explícita: cualquier intent no listado es owner-only por defecto.
  // Esto cierra el fail-open histórico que permitía que intents nuevos
  // pasaran sin gating mientras alguien actualizaba la lista.
  assert.equal(canEmployeeExecuteIntent("intent_que_no_existe"), false);
});

// ── rbacGuard — owner siempre permitido ───────────────────────────────

test("rbacGuard: owner + register_sale → allowed", () => {
  const r = rbacGuard({ kind: "owner" }, "register_sale");
  assert.equal(r.allowed, true);
  assert.equal(r.reason, undefined);
});

test("rbacGuard: owner + edit_product → allowed", () => {
  const r = rbacGuard({ kind: "owner" }, "edit_product");
  assert.equal(r.allowed, true);
});

test("rbacGuard: owner + delete_product → allowed", () => {
  const r = rbacGuard({ kind: "owner" }, "delete_product");
  assert.equal(r.allowed, true);
});

test("rbacGuard: owner + bulk_price_update → allowed", () => {
  const r = rbacGuard({ kind: "owner" }, "bulk_price_update");
  assert.equal(r.allowed, true);
});

test("rbacGuard: owner + stock_load → allowed", () => {
  const r = rbacGuard({ kind: "owner" }, "stock_load");
  assert.equal(r.allowed, true);
});

test("rbacGuard: owner + register_movement → allowed", () => {
  const r = rbacGuard({ kind: "owner" }, "register_movement");
  assert.equal(r.allowed, true);
});

test("rbacGuard: owner + create_supplier → allowed", () => {
  const r = rbacGuard({ kind: "owner" }, "create_supplier");
  assert.equal(r.allowed, true);
});

test("rbacGuard: owner + create_customer → allowed", () => {
  const r = rbacGuard({ kind: "owner" }, "create_customer");
  assert.equal(r.allowed, true);
});

// ── rbacGuard — employee permitido si intent NO destructivo ──────────

test("rbacGuard: employee + register_sale → allowed (core del rol)", () => {
  const r = rbacGuard({ kind: "employee" }, "register_sale");
  assert.equal(r.allowed, true);
  assert.equal(r.reason, undefined);
});

test("rbacGuard: employee + business_query → allowed (read-only)", () => {
  const r = rbacGuard({ kind: "employee" }, "business_query");
  assert.equal(r.allowed, true);
});

test("rbacGuard: employee + check_stock → blocked (no está en allowlist canónica; client-side handler)", () => {
  const r = rbacGuard({ kind: "employee" }, "check_stock");
  assert.equal(r.allowed, false);
});

test("rbacGuard: employee + answer → allowed (chat conversacional)", () => {
  const r = rbacGuard({ kind: "employee" }, "answer");
  assert.equal(r.allowed, true);
});

// ── rbacGuard — employee bloqueado en destructivos ───────────────────

test("rbacGuard: employee + edit_product → blocked con reason", () => {
  const r = rbacGuard({ kind: "employee" }, "edit_product");
  assert.equal(r.allowed, false);
  assert.match(r.reason, /dueño/i);
});

test("rbacGuard: employee + delete_product → blocked con reason", () => {
  const r = rbacGuard({ kind: "employee" }, "delete_product");
  assert.equal(r.allowed, false);
  assert.match(r.reason, /dueño/i);
});

test("rbacGuard: employee + bulk_price_update → blocked", () => {
  const r = rbacGuard({ kind: "employee" }, "bulk_price_update");
  assert.equal(r.allowed, false);
});

test("rbacGuard: employee + stock_load → allowed (A2A intercept gestiona la autorización)", () => {
  const r = rbacGuard({ kind: "employee" }, "stock_load");
  assert.equal(r.allowed, true);
});

test("rbacGuard: employee + adjust_stock → blocked", () => {
  const r = rbacGuard({ kind: "employee" }, "adjust_stock");
  assert.equal(r.allowed, false);
});

test("rbacGuard: employee + stock_adjustment → blocked", () => {
  const r = rbacGuard({ kind: "employee" }, "stock_adjustment");
  assert.equal(r.allowed, false);
});

test("rbacGuard: employee + register_movement → blocked", () => {
  const r = rbacGuard({ kind: "employee" }, "register_movement");
  assert.equal(r.allowed, false);
});

test("rbacGuard: employee + create_supplier → blocked", () => {
  const r = rbacGuard({ kind: "employee" }, "create_supplier");
  assert.equal(r.allowed, false);
});

test("rbacGuard: employee + edit_supplier → blocked", () => {
  const r = rbacGuard({ kind: "employee" }, "edit_supplier");
  assert.equal(r.allowed, false);
});

test("rbacGuard: employee + create_customer → blocked (owner-only por contrato canónico)", () => {
  const r = rbacGuard({ kind: "employee" }, "create_customer");
  assert.equal(r.allowed, false);
  assert.match(r.reason, /dueño/i);
});

test("rbacGuard: employee + edit_customer → blocked (owner-only por contrato canónico)", () => {
  const r = rbacGuard({ kind: "employee" }, "edit_customer");
  assert.equal(r.allowed, false);
  assert.match(r.reason, /dueño/i);
});

// ── rbacGuard — reason no usa lenguaje burocrático ───────────────────

test("rbacGuard: reason del rebote tiene tono cálido (no 'permiso denegado')", () => {
  const intents = [
    "edit_product",
    "delete_product",
    "bulk_price_update",
    "create_supplier",
    "edit_supplier",
    "adjust_stock",
    "stock_adjustment",
    "register_movement",
  ];
  for (const intent of intents) {
    const r = rbacGuard({ kind: "employee" }, intent);
    assert.equal(r.allowed, false, `${intent} should be blocked`);
    assert.doesNotMatch(r.reason.toLowerCase(), /permiso denegado/);
    assert.doesNotMatch(r.reason.toLowerCase(), /no autorizado/);
    assert.doesNotMatch(r.reason.toLowerCase(), /forbidden/);
    assert.doesNotMatch(r.reason.toLowerCase(), /403/);
  }
});

// ── rbacGuard — fail-closed en intent desconocido ────────────────────

test("rbacGuard: employee + intent desconocido → blocked (fail-closed por allowlist canónica)", () => {
  // El contrato canónico es una allowlist: cualquier intent no listado es
  // owner-only por defecto. Esto previene que un intent nuevo agregado al
  // detector sin actualizar la allowlist se filtre como permitido.
  const r = rbacGuard({ kind: "employee" }, "x_intent_inexistente");
  assert.equal(r.allowed, false);
  assert.match(r.reason, /dueño/i);
});
