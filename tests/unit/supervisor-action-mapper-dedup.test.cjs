"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");

// supervisor-action-mapper-dedup.test.cjs
// Verifies the compound-action dedup invariant added to
// mapSupervisorActionsToCompoundActions / dedupSupervisorActions.
//
// Key correctness rule: dedup is by intent+data, NOT intent alone.
// Two different payloads for the same intent (e.g. two stock_load with
// different products or quantities) must BOTH survive. Only byte-identical
// duplicates are collapsed.

const {
  mapSupervisorActionsToCompoundActions,
} = require("../../src/app/api/business-assistant/_lib/supervisor-action-mapper.ts");

const {
  dedupSupervisorActions,
} = require("../../src/app/api/business-assistant/_lib/supervisor-action-mapper.dedup.ts");

const PRODUCTS = [
  { id: "p1", name: "Producto A", sku: null, price: 100 },
  { id: "p2", name: "Producto B", sku: null, price: 200 },
];
const CUSTOMERS = [];
const SUPPLIERS = [];

function makeAction(intent, data) {
  return { intent, data, summary: "" };
}

function map(actions) {
  return mapSupervisorActionsToCompoundActions(actions, PRODUCTS, CUSTOMERS, SUPPLIERS, "");
}

// ── dedupSupervisorActions unit ───────────────────────────────────────────────

test("dedup: identical stock_load actions (same product + qty) → one survives", () => {
  const actions = [
    makeAction("stock_load", { itemName: "Producto A", quantity: 5, supplierName: "Proveedor" }),
    makeAction("stock_load", { itemName: "Producto A", quantity: 5, supplierName: "Proveedor" }),
  ];
  const result = dedupSupervisorActions(actions);
  assert.equal(result.length, 1);
});

test("dedup: stock_load with different products → both survive", () => {
  const actions = [
    makeAction("stock_load", { itemName: "Producto A", quantity: 5, supplierName: "Proveedor" }),
    makeAction("stock_load", { itemName: "Producto B", quantity: 3, supplierName: "Proveedor" }),
  ];
  const result = dedupSupervisorActions(actions);
  assert.equal(result.length, 2);
});

test("dedup: stock_load same product but different quantity → both survive", () => {
  const actions = [
    makeAction("stock_load", { itemName: "Producto A", quantity: 5, supplierName: "Proveedor" }),
    makeAction("stock_load", { itemName: "Producto A", quantity: 10, supplierName: "Proveedor" }),
  ];
  const result = dedupSupervisorActions(actions);
  assert.equal(result.length, 2);
});

test("dedup: identical register_movement actions → one survives", () => {
  const actions = [
    makeAction("register_movement", { movementType: "purchase", amount: 500, description: "compra insumos" }),
    makeAction("register_movement", { movementType: "purchase", amount: 500, description: "compra insumos" }),
  ];
  const result = dedupSupervisorActions(actions);
  assert.equal(result.length, 1);
});

test("dedup: register_movement with different amounts → both survive", () => {
  const actions = [
    makeAction("register_movement", { movementType: "purchase", amount: 500, description: "compra A" }),
    makeAction("register_movement", { movementType: "purchase", amount: 200, description: "compra B" }),
  ];
  const result = dedupSupervisorActions(actions);
  assert.equal(result.length, 2);
});

test("dedup: keeps first occurrence, drops later duplicates", () => {
  const actions = [
    makeAction("stock_load", { itemName: "Producto A", quantity: 5, supplierName: "S" }),
    makeAction("stock_load", { itemName: "Producto A", quantity: 5, supplierName: "S" }),
    makeAction("stock_load", { itemName: "Producto A", quantity: 5, supplierName: "S" }),
  ];
  const result = dedupSupervisorActions(actions);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].data, actions[0].data);
});

test("dedup: different intents with identical data are NOT collapsed", () => {
  // adjust_stock and stock_load are different intents even if data looks similar
  const actions = [
    makeAction("adjust_stock", { productName: "Producto A", mode: "increase", quantity: 5 }),
    makeAction("stock_load", { itemName: "Producto A", quantity: 5, supplierName: "" }),
  ];
  const result = dedupSupervisorActions(actions);
  assert.equal(result.length, 2);
});

// ── End-to-end via mapSupervisorActionsToCompoundActions ──────────────────────

test("mapper: [stock_load(A,5), stock_load(A,5)] → one CompoundAction", () => {
  const actions = [
    makeAction("stock_load", { itemName: "Producto A", quantity: 5, supplierName: "Proveedor" }),
    makeAction("stock_load", { itemName: "Producto A", quantity: 5, supplierName: "Proveedor" }),
  ];
  const result = map(actions);
  assert.equal(result.length, 1);
  assert.equal(result[0].type, "stock_load");
});

test("mapper: [stock_load(A,5), stock_load(B,3)] → two CompoundActions", () => {
  const actions = [
    makeAction("stock_load", { itemName: "Producto A", quantity: 5, supplierName: "Proveedor" }),
    makeAction("stock_load", { itemName: "Producto B", quantity: 3, supplierName: "Proveedor" }),
  ];
  const result = map(actions);
  assert.equal(result.length, 2);
  assert.equal(result[0].type, "stock_load");
  assert.equal(result[1].type, "stock_load");
});

test("mapper: [register_movement dup] → one CompoundAction", () => {
  const actions = [
    makeAction("register_movement", { movementType: "purchase", amount: 500, description: "compra insumos" }),
    makeAction("register_movement", { movementType: "purchase", amount: 500, description: "compra insumos" }),
  ];
  const result = map(actions);
  assert.equal(result.length, 1);
  assert.equal(result[0].type, "register_movement");
});

test("mapper: non-duplicates of different intents are unaffected", () => {
  const actions = [
    makeAction("stock_load", { itemName: "Producto A", quantity: 5, supplierName: "S" }),
    makeAction("register_movement", { movementType: "income", amount: 1000, description: "cobro" }),
    makeAction("adjust_stock", { productName: "Producto A", mode: "increase", quantity: 3 }),
  ];
  const result = map(actions);
  assert.equal(result.length, 3);
});
