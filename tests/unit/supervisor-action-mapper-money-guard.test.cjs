"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");

// supervisor-action-mapper-money-guard.test.cjs
// H-3 money-safety guard: verifies that LLM-invented unitPrice on
// register_sale actions is stripped when it deviates from the catalog
// price and the owner's raw text contains no explicit price.

const {
  mapSupervisorActionsToCompoundActions,
} = require("../../src/app/api/business-assistant/_lib/supervisor-action-mapper.ts");

const PRODUCTS = [
  { id: "p1", name: "Tuerca M8", sku: null, price: 2500 },
  { id: "p2", name: "Alfajor", sku: null, price: 150 },
  { id: "p3", name: "Sin precio", sku: null, price: null },
];
const CUSTOMERS = [{ id: "c1", name: "Carlos Rossi" }];
const SUPPLIERS = [];

function makeAction(data) {
  return { intent: "register_sale", data, summary: "" };
}

function map(actions, rawOwnerText = "") {
  return mapSupervisorActionsToCompoundActions(actions, PRODUCTS, CUSTOMERS, SUPPLIERS, rawOwnerText);
}

// ── Guard fires: LLM price deviates, no explicit price in owner text ─────────

test("H-3: strips unitPrice when LLM invents a price far below catalog with no explicit price in text", () => {
  const actions = [makeAction({ productName: "Tuerca M8", qty: 1, unitPrice: 1 })];
  const [result] = map(actions, "vendé una tuerca");
  assert.equal(result.type, "register_sale");
  assert.equal(result.unitPrice, undefined, "LLM-invented price 1 vs catalog 2500 must be stripped");
});

test("H-3: strips unitPrice when LLM invents a price far above catalog with no explicit price in text", () => {
  const actions = [makeAction({ productName: "Alfajor", qty: 2, unitPrice: 99999 })];
  const [result] = map(actions, "vendé 2 alfajores a carlos");
  assert.equal(result.type, "register_sale");
  assert.equal(result.unitPrice, undefined, "LLM-invented inflated price must be stripped");
});

// ── Guard fires: a number in the text is a QUANTITY, not the emitted price ───
// (jd/supervisor-h3-money-guard Issue 2 — the dangerous false-positive class)

test("H-3: strips LLM price when the only number in text is a large quantity (B2B bulk sale)", () => {
  // "vendé 2500 alfajores" — 2500 is the qty; LLM invents unitPrice 1 (catalog 150).
  const actions = [makeAction({ productName: "Alfajor", qty: 2500, unitPrice: 1 })];
  const [result] = map(actions, "vendé 2500 alfajores a Carlos");
  assert.equal(result.unitPrice, undefined, "qty 2500 must NOT be read as a price — invented unitPrice 1 must be stripped");
});

test("H-3: strips LLM price when text number is a 2-digit quantity", () => {
  const actions = [makeAction({ productName: "Tuerca M8", qty: 12, unitPrice: 100 })];
  const [result] = map(actions, "vendé 12 tuercas");
  assert.equal(result.unitPrice, undefined, "qty 12 != invented price 100 — must be stripped");
});

test("H-3: strips when LLM copies the quantity into the price field (qty == unitPrice)", () => {
  // jd round 2 HIGH: "vendé 2500 alfajores" with LLM unitPrice=2500 (the qty).
  // The qty token must be excluded so it is NOT read as an owner-stated price.
  const actions = [makeAction({ productName: "Alfajor", qty: 2500, unitPrice: 2500 })];
  const [result] = map(actions, "vendé 2500 alfajores a Carlos");
  assert.equal(result.unitPrice, undefined, "qty 2500 copied into price must be stripped — 16x overcharge otherwise");
});

test("H-3: strips invented price that coincides with a percentage number in text", () => {
  const actions = [makeAction({ productName: "Tuerca M8", qty: 1, unitPrice: 50 })];
  const [result] = map(actions, "vendé una tuerca con 50% descuento");
  assert.equal(result.unitPrice, undefined, "the 50 in '50%' is not a price — invented unitPrice 50 must be stripped");
});

// ── Guard does NOT fire: literal "$" price, including single digit (Issue 1) ──

test("H-3: honours a single-digit price written with $ (old regex missed this)", () => {
  const actions = [makeAction({ productName: "Alfajor", qty: 1, unitPrice: 5 })];
  const [result] = map(actions, "vendé un alfajor a $5");
  assert.equal(result.unitPrice, 5, "owner literally wrote $5 — must be honoured even though it deviates from catalog 150");
});

// ── Guard does NOT fire: owner explicitly stated a price ─────────────────────

test("H-3: honours unitPrice when owner text contains an explicit price number", () => {
  const actions = [makeAction({ productName: "Tuerca M8", qty: 1, unitPrice: 3000 })];
  const [result] = map(actions, "vendé una tuerca a 3000");
  assert.equal(result.type, "register_sale");
  assert.equal(result.unitPrice, 3000, "owner-stated price must pass through even if different from catalog");
});

test("H-3: honours unitPrice when owner text contains a price with $ prefix", () => {
  const actions = [makeAction({ productName: "Tuerca M8", qty: 1, unitPrice: 2000 })];
  const [result] = map(actions, "vendé una tuerca a $2000");
  assert.equal(result.type, "register_sale");
  assert.equal(result.unitPrice, 2000, "price with $ prefix must be treated as owner-stated");
});

// ── Guard does NOT fire: LLM price within tolerance (floating-point drift) ───

test("H-3: passes through unitPrice within 1% tolerance of catalog price", () => {
  // 2500 * 1% = 25; 2505 is within tolerance
  const actions = [makeAction({ productName: "Tuerca M8", qty: 1, unitPrice: 2505 })];
  const [result] = map(actions, "vendé una tuerca");
  assert.equal(result.type, "register_sale");
  assert.equal(result.unitPrice, 2505, "price within 1% tolerance must not be stripped");
});

test("H-3: passes through unitPrice equal to catalog price", () => {
  const actions = [makeAction({ productName: "Tuerca M8", qty: 1, unitPrice: 2500 })];
  const [result] = map(actions, "vendé una tuerca");
  assert.equal(result.type, "register_sale");
  assert.equal(result.unitPrice, 2500, "exact catalog price must pass through");
});

// ── Guard does NOT fire: product has no catalog price → cannot cross-reference

test("H-3: passes through unitPrice when product has no catalog price (cannot cross-reference)", () => {
  const actions = [makeAction({ productName: "Sin precio", qty: 1, unitPrice: 999 })];
  const [result] = map(actions, "vendé uno sin precio");
  assert.equal(result.type, "register_sale");
  assert.equal(result.unitPrice, 999, "without a catalog price there is no reference to guard against");
});

// ── Guard does NOT fire: unitPrice undefined / missing → nothing to guard ─────

test("H-3: passes through correctly when unitPrice is absent from LLM data", () => {
  const actions = [makeAction({ productName: "Tuerca M8", qty: 1 })];
  const [result] = map(actions, "vendé una tuerca");
  assert.equal(result.type, "register_sale");
  assert.equal(result.unitPrice, undefined, "absent unitPrice must remain undefined");
});

// ── Non-register_sale actions are unaffected ─────────────────────────────────

test("H-3: non-monetary actions pass through unmolested", () => {
  const actions = [{ intent: "adjust_stock", data: { productName: "Tuerca M8", mode: "increase", quantity: 10 }, summary: "" }];
  const [result] = map(actions, "sumá 10 tuercas");
  assert.equal(result.type, "adjust_stock");
});
