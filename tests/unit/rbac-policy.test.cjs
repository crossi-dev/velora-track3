const assert = require("node:assert/strict");
const test = require("node:test");

const {
  COMPANION_DESTRUCTIVE_INTENTS,
  canCompanionExecuteIntent,
  rbacGuard,
} = require("../../src/app/api/business-assistant/_lib/rbac-policy.ts");

// ── COMPANION_DESTRUCTIVE_INTENTS — lista canónica del Brief ───────────

test("COMPANION_DESTRUCTIVE_INTENTS: incluye edit_product", () => {
  assert.equal(COMPANION_DESTRUCTIVE_INTENTS.has("edit_product"), true);
});

test("COMPANION_DESTRUCTIVE_INTENTS: incluye delete_product", () => {
  assert.equal(COMPANION_DESTRUCTIVE_INTENTS.has("delete_product"), true);
});

test("COMPANION_DESTRUCTIVE_INTENTS: incluye bulk_price_update", () => {
  assert.equal(COMPANION_DESTRUCTIVE_INTENTS.has("bulk_price_update"), true);
});

test("COMPANION_DESTRUCTIVE_INTENTS: incluye create_supplier", () => {
  assert.equal(COMPANION_DESTRUCTIVE_INTENTS.has("create_supplier"), true);
});

test("COMPANION_DESTRUCTIVE_INTENTS: incluye edit_supplier", () => {
  assert.equal(COMPANION_DESTRUCTIVE_INTENTS.has("edit_supplier"), true);
});

test("COMPANION_DESTRUCTIVE_INTENTS: incluye create_customer (owner-only por contrato canónico)", () => {
  // Pre-2026-05-09 esto estaba marcado como permitido al empleado por una nota
  // sobre el "flujo de venta" — contradecía role-contract OWNER_ONLY_INTENTS.
  assert.equal(COMPANION_DESTRUCTIVE_INTENTS.has("create_customer"), true);
});

test("COMPANION_DESTRUCTIVE_INTENTS: incluye edit_customer (owner-only por contrato canónico)", () => {
  // Pre-2026-05-09 esto estaba marcado como permitido al empleado por una nota
  // sobre "corrección de datos en venta" — contradecía role-contract.
  assert.equal(COMPANION_DESTRUCTIVE_INTENTS.has("edit_customer"), true);
});

test("COMPANION_DESTRUCTIVE_INTENTS: NO incluye stock_load (pasa por A2A supervisor intercept)", () => {
  assert.equal(COMPANION_DESTRUCTIVE_INTENTS.has("stock_load"), false);
});

test("COMPANION_DESTRUCTIVE_INTENTS: incluye adjust_stock", () => {
  assert.equal(COMPANION_DESTRUCTIVE_INTENTS.has("adjust_stock"), true);
});

test("COMPANION_DESTRUCTIVE_INTENTS: incluye stock_adjustment", () => {
  assert.equal(COMPANION_DESTRUCTIVE_INTENTS.has("stock_adjustment"), true);
});

test("COMPANION_DESTRUCTIVE_INTENTS: incluye register_movement", () => {
  assert.equal(COMPANION_DESTRUCTIVE_INTENTS.has("register_movement"), true);
});

test("COMPANION_DESTRUCTIVE_INTENTS: NO incluye register_sale (core del rol cashier)", () => {
  assert.equal(COMPANION_DESTRUCTIVE_INTENTS.has("register_sale"), false);
});

test("COMPANION_DESTRUCTIVE_INTENTS: NO incluye business_query (read-only)", () => {
  assert.equal(COMPANION_DESTRUCTIVE_INTENTS.has("business_query"), false);
});

test("COMPANION_DESTRUCTIVE_INTENTS: NO incluye check_stock (read-only, resuelto client-side)", () => {
  // check_stock vive en el Command Layer del dashboard y nunca llega al RBAC
  // server-side. No está en OWNER_ONLY_INTENTS — está fuera del set canónico.
  assert.equal(COMPANION_DESTRUCTIVE_INTENTS.has("check_stock"), false);
});

test("COMPANION_DESTRUCTIVE_INTENTS: NO incluye answer (chat conversacional)", () => {
  assert.equal(COMPANION_DESTRUCTIVE_INTENTS.has("answer"), false);
});

// ── canCompanionExecuteIntent ──────────────────────────────────────────

test("canCompanionExecuteIntent: register_sale → true", () => {
  assert.equal(canCompanionExecuteIntent("register_sale"), true);
});

test("canCompanionExecuteIntent: business_query → true", () => {
  assert.equal(canCompanionExecuteIntent("business_query"), true);
});

test("canCompanionExecuteIntent: answer → true", () => {
  assert.equal(canCompanionExecuteIntent("answer"), true);
});

test("canCompanionExecuteIntent: check_stock → false (no está en allowlist canónica; se resuelve client-side)", () => {
  // check_stock vive en el Command Layer del dashboard. Si por alguna razón
  // un payload llegara al server-side rbac con ese intent, fail-closed.
  assert.equal(canCompanionExecuteIntent("check_stock"), false);
});

test("canCompanionExecuteIntent: edit_product → false", () => {
  assert.equal(canCompanionExecuteIntent("edit_product"), false);
});

test("canCompanionExecuteIntent: delete_product → false", () => {
  assert.equal(canCompanionExecuteIntent("delete_product"), false);
});

test("canCompanionExecuteIntent: bulk_price_update → false", () => {
  assert.equal(canCompanionExecuteIntent("bulk_price_update"), false);
});

test("canCompanionExecuteIntent: stock_load → true (pasa por A2A supervisor intercept)", () => {
  assert.equal(canCompanionExecuteIntent("stock_load"), true);
});

test("canCompanionExecuteIntent: adjust_stock → false", () => {
  assert.equal(canCompanionExecuteIntent("adjust_stock"), false);
});

test("canCompanionExecuteIntent: register_movement → false", () => {
  assert.equal(canCompanionExecuteIntent("register_movement"), false);
});

test("canCompanionExecuteIntent: create_supplier → false", () => {
  assert.equal(canCompanionExecuteIntent("create_supplier"), false);
});

test("canCompanionExecuteIntent: edit_supplier → false", () => {
  assert.equal(canCompanionExecuteIntent("edit_supplier"), false);
});

test("canCompanionExecuteIntent: create_customer → false (owner-only por contrato canónico)", () => {
  assert.equal(canCompanionExecuteIntent("create_customer"), false);
});

test("canCompanionExecuteIntent: edit_customer → false (owner-only por contrato canónico)", () => {
  assert.equal(canCompanionExecuteIntent("edit_customer"), false);
});

test("canCompanionExecuteIntent: intent desconocido → false (fail-closed; allowlist canónica)", () => {
  // El contrato canónico (role-contract.ts COMPANION_ALLOWED_INTENTS) es una
  // allowlist explícita: cualquier intent no listado es owner-only por defecto.
  // Esto cierra el fail-open histórico que permitía que intents nuevos
  // pasaran sin gating mientras alguien actualizaba la lista.
  assert.equal(canCompanionExecuteIntent("intent_que_no_existe"), false);
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

// ── rbacGuard — companion permitido si intent NO destructivo ──────────

test("rbacGuard: companion + register_sale → allowed (core del rol)", () => {
  const r = rbacGuard({ kind: "companion" }, "register_sale");
  assert.equal(r.allowed, true);
  assert.equal(r.reason, undefined);
});

test("rbacGuard: companion + business_query → allowed (read-only)", () => {
  const r = rbacGuard({ kind: "companion" }, "business_query");
  assert.equal(r.allowed, true);
});

test("rbacGuard: companion + check_stock → blocked (no está en allowlist canónica; client-side handler)", () => {
  const r = rbacGuard({ kind: "companion" }, "check_stock");
  assert.equal(r.allowed, false);
});

test("rbacGuard: companion + answer → allowed (chat conversacional)", () => {
  const r = rbacGuard({ kind: "companion" }, "answer");
  assert.equal(r.allowed, true);
});

// ── rbacGuard — companion bloqueado en destructivos ───────────────────

test("rbacGuard: companion + edit_product → blocked con reason", () => {
  const r = rbacGuard({ kind: "companion" }, "edit_product");
  assert.equal(r.allowed, false);
  assert.match(r.reason, /dueño/i);
});

test("rbacGuard: companion + delete_product → blocked con reason", () => {
  const r = rbacGuard({ kind: "companion" }, "delete_product");
  assert.equal(r.allowed, false);
  assert.match(r.reason, /dueño/i);
});

test("rbacGuard: companion + bulk_price_update → blocked", () => {
  const r = rbacGuard({ kind: "companion" }, "bulk_price_update");
  assert.equal(r.allowed, false);
});

test("rbacGuard: companion + stock_load → allowed (A2A intercept gestiona la autorización)", () => {
  const r = rbacGuard({ kind: "companion" }, "stock_load");
  assert.equal(r.allowed, true);
});

test("rbacGuard: companion + adjust_stock → blocked", () => {
  const r = rbacGuard({ kind: "companion" }, "adjust_stock");
  assert.equal(r.allowed, false);
});

test("rbacGuard: companion + stock_adjustment → blocked", () => {
  const r = rbacGuard({ kind: "companion" }, "stock_adjustment");
  assert.equal(r.allowed, false);
});

test("rbacGuard: companion + register_movement → blocked", () => {
  const r = rbacGuard({ kind: "companion" }, "register_movement");
  assert.equal(r.allowed, false);
});

test("rbacGuard: companion + create_supplier → blocked", () => {
  const r = rbacGuard({ kind: "companion" }, "create_supplier");
  assert.equal(r.allowed, false);
});

test("rbacGuard: companion + edit_supplier → blocked", () => {
  const r = rbacGuard({ kind: "companion" }, "edit_supplier");
  assert.equal(r.allowed, false);
});

test("rbacGuard: companion + create_customer → blocked (owner-only por contrato canónico)", () => {
  const r = rbacGuard({ kind: "companion" }, "create_customer");
  assert.equal(r.allowed, false);
  assert.match(r.reason, /dueño/i);
});

test("rbacGuard: companion + edit_customer → blocked (owner-only por contrato canónico)", () => {
  const r = rbacGuard({ kind: "companion" }, "edit_customer");
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
    const r = rbacGuard({ kind: "companion" }, intent);
    assert.equal(r.allowed, false, `${intent} should be blocked`);
    assert.doesNotMatch(r.reason.toLowerCase(), /permiso denegado/);
    assert.doesNotMatch(r.reason.toLowerCase(), /no autorizado/);
    assert.doesNotMatch(r.reason.toLowerCase(), /forbidden/);
    assert.doesNotMatch(r.reason.toLowerCase(), /403/);
  }
});

// ── rbacGuard — fail-closed en intent desconocido ────────────────────

test("rbacGuard: companion + intent desconocido → blocked (fail-closed por allowlist canónica)", () => {
  // El contrato canónico es una allowlist: cualquier intent no listado es
  // owner-only por defecto. Esto previene que un intent nuevo agregado al
  // detector sin actualizar la allowlist se filtre como permitido.
  const r = rbacGuard({ kind: "companion" }, "x_intent_inexistente");
  assert.equal(r.allowed, false);
  assert.match(r.reason, /dueño/i);
});
