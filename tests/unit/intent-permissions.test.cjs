const assert = require("node:assert/strict");
const test = require("node:test");

const {
  isIntentAllowedForRole,
  buildEmployeeRefusal,
} = require("../../src/app/api/business-assistant/_lib/intent-permissions.ts");

// ── Owner: todo permitido ──────────────────────────────────────────────

test("owner: register_sale allowed", () => {
  assert.equal(isIntentAllowedForRole("owner", "register_sale"), true);
});

test("owner: edit_product allowed", () => {
  assert.equal(isIntentAllowedForRole("owner", "edit_product"), true);
});

test("owner: stock_load allowed", () => {
  assert.equal(isIntentAllowedForRole("owner", "stock_load"), true);
});

test("owner: bulk_price_update allowed", () => {
  assert.equal(isIntentAllowedForRole("owner", "bulk_price_update"), true);
});

test("owner: register_movement allowed", () => {
  assert.equal(isIntentAllowedForRole("owner", "register_movement"), true);
});

// ── Employee: only the safe whitelist ──────────────────────────────────

test("employee: answer always allowed", () => {
  assert.equal(isIntentAllowedForRole("employee", "answer"), true);
});

test("employee: register_sale allowed (core del rol)", () => {
  assert.equal(isIntentAllowedForRole("employee", "register_sale"), true);
});

test("employee: business_query allowed (read)", () => {
  assert.equal(isIntentAllowedForRole("employee", "business_query"), true);
});

test("employee: stock_load allowed (A2A supervisor intercept gestiona la autorización)", () => {
  assert.equal(isIntentAllowedForRole("employee", "stock_load"), true);
});

test("employee: report_event allowed", () => {
  assert.equal(isIntentAllowedForRole("employee", "report_event"), true);
});

test("employee: check_stock BLOCKED (owner-only per franchise model)", () => {
  assert.equal(isIntentAllowedForRole("employee", "check_stock"), false);
});

test("employee: create_customer BLOCKED (owner-only per franchise model)", () => {
  assert.equal(isIntentAllowedForRole("employee", "create_customer"), false);
});

test("employee: edit_customer BLOCKED (owner-only per industry standard)", () => {
  assert.equal(isIntentAllowedForRole("employee", "edit_customer"), false);
  const refusal = buildEmployeeRefusal("edit_customer");
  assert.match(refusal.answer, /dueño/i);
  assert.equal(refusal.forbiddenIntent, "edit_customer");
});

test("employee: edit_product BLOCKED (owner-only)", () => {
  assert.equal(isIntentAllowedForRole("employee", "edit_product"), false);
});

test("employee: delete_product BLOCKED", () => {
  assert.equal(isIntentAllowedForRole("employee", "delete_product"), false);
});

test("employee: bulk_price_update BLOCKED", () => {
  assert.equal(isIntentAllowedForRole("employee", "bulk_price_update"), false);
});

test("employee: adjust_stock BLOCKED", () => {
  assert.equal(isIntentAllowedForRole("employee", "adjust_stock"), false);
});

test("employee: register_movement BLOCKED (cash movements owner-only)", () => {
  assert.equal(isIntentAllowedForRole("employee", "register_movement"), false);
});

test("employee: create_supplier BLOCKED", () => {
  assert.equal(isIntentAllowedForRole("employee", "create_supplier"), false);
});

test("employee: edit_supplier BLOCKED", () => {
  assert.equal(isIntentAllowedForRole("employee", "edit_supplier"), false);
});

// ── Refusal builders ───────────────────────────────────────────────────

test("buildEmployeeRefusal: edit_product menciona dueño", () => {
  const r = buildEmployeeRefusal("edit_product");
  assert.match(r.answer, /dueño/i);
  assert.equal(r.forbiddenIntent, "edit_product");
});

test("buildEmployeeRefusal: register_movement menciona caja", () => {
  const r = buildEmployeeRefusal("register_movement");
  assert.match(r.answer, /caja/i);
});

test("buildEmployeeRefusal: tono cálido — no usa 'permiso denegado' ni 'no autorizado'", () => {
  const intents = [
    "edit_product",
    "delete_product",
    "adjust_stock",
    "register_movement",
    "create_supplier",
    "edit_supplier",
    "bulk_price_update",
  ];
  for (const intent of intents) {
    const r = buildEmployeeRefusal(intent);
    assert.doesNotMatch(r.answer.toLowerCase(), /permiso denegado/);
    assert.doesNotMatch(r.answer.toLowerCase(), /no autorizado/);
    assert.doesNotMatch(r.answer.toLowerCase(), /forbidden/);
    assert.doesNotMatch(r.answer.toLowerCase(), /403/);
  }
});
