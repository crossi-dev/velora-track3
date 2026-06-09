// Unit tests for customer-agent-tools-order.ts — the deterministic order/cart
// tool (update_order_item). This is the core of the 3->33 fix: price and stock
// come from the DB, totals are computed server-side, and the LLM only passes
// productId + integer quantity. We assert the cart math is deterministic and the
// stock guard fires.
//
// Mocking mirrors customer-agent-tools.test.cjs: Module._cache injection for
// prisma + cloudLog + @google/adk FunctionTool + @google/genai Type.

"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const Module = require("node:module");
const path = require("node:path");

const SUT_PATH = path.resolve(__dirname, "../../src/lib/adk/customer-agent-tools-order.ts");
const CLOUD_LOGGER_PATH = path.resolve(__dirname, "../../src/lib/cloud-logger.ts");

// Per-test mutable state
let mockProduct = null;

function installMocks() {
  const mockPrisma = {
    product: {
      findFirst: async () => mockProduct,
    },
  };
  const prismaResolvedPath = require.resolve("@/lib/prisma");
  Module._cache[prismaResolvedPath] = {
    id: prismaResolvedPath, filename: prismaResolvedPath, loaded: true,
    exports: { prisma: mockPrisma },
  };
  Module._cache[CLOUD_LOGGER_PATH] = {
    id: CLOUD_LOGGER_PATH, filename: CLOUD_LOGGER_PATH, loaded: true,
    exports: { cloudLog: () => {} },
  };
  const adkPath = require.resolve("@google/adk");
  Module._cache[adkPath] = {
    id: adkPath, filename: adkPath, loaded: true,
    exports: {
      FunctionTool: class FakeFunctionTool {
        constructor({ execute, name }) { this.execute = execute; this.name = name; }
      },
    },
  };
  const genaiPath = require.resolve("@google/genai");
  Module._cache[genaiPath] = {
    id: genaiPath, filename: genaiPath, loaded: true,
    exports: { Type: { OBJECT: "OBJECT", STRING: "STRING", NUMBER: "NUMBER" } },
  };
}

function loadTool() {
  delete Module._cache[SUT_PATH];
  return require(SUT_PATH);
}

/** Minimal ADK tool_context with a Map-backed session state. */
function makeCtx() {
  const store = new Map();
  return {
    state: {
      get: (k, d) => (store.has(k) ? store.get(k) : d),
      set: (k, v) => store.set(k, v),
    },
    _store: store,
  };
}

const toolCtx = { businessId: "biz-1", customerPhone: "+5492612345678", appUrl: "http://localhost" };

// ── Deterministic line total ─────────────────────────────────────────────────

test("update_order_item: qty 3 × $500 → lineTotal 1500, subtotal 1500", async () => {
  installMocks();
  mockProduct = { id: "p1", name: "Alfajor", price: 500, quantity: 100 };
  const { createUpdateOrderItemTool } = loadTool();
  const tool = createUpdateOrderItemTool(toolCtx);
  const tc = makeCtx();

  const res = await tool.execute({ productId: "p1", quantity: 3 }, tc);

  assert.ok(res.order, "returns the cart");
  assert.equal(res.order.items.length, 1);
  assert.equal(res.order.items[0].qty, 3);
  assert.equal(res.order.items[0].lineTotal, 1500);
  assert.equal(res.order.subtotal, 1500);
});

test("update_order_item: '3' is never inflated to 33", async () => {
  installMocks();
  mockProduct = { id: "p1", name: "Alfajor", price: 500, quantity: 100 };
  const { createUpdateOrderItemTool } = loadTool();
  const tool = createUpdateOrderItemTool(toolCtx);
  const tc = makeCtx();

  const res = await tool.execute({ productId: "p1", quantity: 3 }, tc);
  assert.equal(res.order.items[0].qty, 3);
  assert.notEqual(res.order.subtotal, 16500); // the old 3->33 bug total
});

// ── Stock guard ──────────────────────────────────────────────────────────────

test("update_order_item: qty over stock → error, no cart write", async () => {
  installMocks();
  mockProduct = { id: "p1", name: "Alfajor", price: 500, quantity: 2 };
  const { createUpdateOrderItemTool } = loadTool();
  const tool = createUpdateOrderItemTool(toolCtx);
  const tc = makeCtx();

  const res = await tool.execute({ productId: "p1", quantity: 5 }, tc);
  assert.ok(res.error, "must reject qty > stock");
  assert.equal(res.available, 2);
  assert.equal(tc._store.has("order"), false, "cart not written on rejection");
});

// ── qty 0 removes line ───────────────────────────────────────────────────────

test("update_order_item: qty 0 removes the line", async () => {
  installMocks();
  mockProduct = { id: "p1", name: "Alfajor", price: 500, quantity: 100 };
  const { createUpdateOrderItemTool } = loadTool();
  const tool = createUpdateOrderItemTool(toolCtx);
  const tc = makeCtx();

  await tool.execute({ productId: "p1", quantity: 2 }, tc);
  const res = await tool.execute({ productId: "p1", quantity: 0 }, tc);
  assert.equal(res.order.items.length, 0);
  assert.equal(res.order.subtotal, 0);
});

// ── unknown product ──────────────────────────────────────────────────────────

test("update_order_item: unknown productId → error", async () => {
  installMocks();
  mockProduct = null;
  const { createUpdateOrderItemTool } = loadTool();
  const tool = createUpdateOrderItemTool(toolCtx);
  const tc = makeCtx();

  const res = await tool.execute({ productId: "nope", quantity: 1 }, tc);
  assert.ok(res.error);
});
