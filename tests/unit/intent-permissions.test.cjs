const assert = require("node:assert/strict");
const test = require("node:test");

const {
  isIntentAllowedForRole,
  buildCompanionRefusal,
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

// ── Companion: only the safe whitelist ──────────────────────────────────

test("companion: answer always allowed", () => {
  assert.equal(isIntentAllowedForRole("companion", "answer"), true);
});

test("companion: register_sale allowed (core del rol)", () => {
  assert.equal(isIntentAllowedForRole("companion", "register_sale"), true);
});

test("companion: business_query allowed (read)", () => {
  assert.equal(isIntentAllowedForRole("companion", "business_query"), true);
});

test("companion: stock_load allowed (A2A supervisor intercept gestiona la autorización)", () => {
  assert.equal(isIntentAllowedForRole("companion", "stock_load"), true);
});

test("companion: report_event allowed", () => {
  assert.equal(isIntentAllowedForRole("companion", "report_event"), true);
});

test("companion: check_stock BLOCKED (owner-only per franchise model)", () => {
  assert.equal(isIntentAllowedForRole("companion", "check_stock"), false);
});

test("companion: create_customer BLOCKED (owner-only per franchise model)", () => {
  assert.equal(isIntentAllowedForRole("companion", "create_customer"), false);
});

test("companion: edit_customer BLOCKED (owner-only per industry standard)", () => {
  assert.equal(isIntentAllowedForRole("companion", "edit_customer"), false);
  const refusal = buildCompanionRefusal("edit_customer");
  assert.match(refusal.answer, /dueño/i);
  assert.equal(refusal.forbiddenIntent, "edit_customer");
});

test("companion: edit_product BLOCKED (owner-only)", () => {
  assert.equal(isIntentAllowedForRole("companion", "edit_product"), false);
});

test("companion: delete_product BLOCKED", () => {
  assert.equal(isIntentAllowedForRole("companion", "delete_product"), false);
});

test("companion: bulk_price_update BLOCKED", () => {
  assert.equal(isIntentAllowedForRole("companion", "bulk_price_update"), false);
});

test("companion: adjust_stock BLOCKED", () => {
  assert.equal(isIntentAllowedForRole("companion", "adjust_stock"), false);
});

test("companion: register_movement BLOCKED (cash movements owner-only)", () => {
  assert.equal(isIntentAllowedForRole("companion", "register_movement"), false);
});

test("companion: create_supplier BLOCKED", () => {
  assert.equal(isIntentAllowedForRole("companion", "create_supplier"), false);
});

test("companion: edit_supplier BLOCKED", () => {
  assert.equal(isIntentAllowedForRole("companion", "edit_supplier"), false);
});

// ── Refusal builders ───────────────────────────────────────────────────

test("buildCompanionRefusal: edit_product menciona dueño", () => {
  const r = buildCompanionRefusal("edit_product");
  assert.match(r.answer, /dueño/i);
  assert.equal(r.forbiddenIntent, "edit_product");
});

test("buildCompanionRefusal: register_movement menciona caja", () => {
  const r = buildCompanionRefusal("register_movement");
  assert.match(r.answer, /caja/i);
});

test("buildCompanionRefusal: tono cálido — no usa 'permiso denegado' ni 'no autorizado'", () => {
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
    const r = buildCompanionRefusal(intent);
    assert.doesNotMatch(r.answer.toLowerCase(), /permiso denegado/);
    assert.doesNotMatch(r.answer.toLowerCase(), /no autorizado/);
    assert.doesNotMatch(r.answer.toLowerCase(), /forbidden/);
    assert.doesNotMatch(r.answer.toLowerCase(), /403/);
  }
});
