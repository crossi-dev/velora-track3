"use strict";

// Unit tests for createMpPreference multi-item breakdown (UX gap fix 2026-05-25).
//
// Updated 2026-05-30: replaced global.fetch interception with mercadopago SDK mock
// after the official SDK replaced the hand-rolled fetch transport. The test
// captures the `body` argument passed to Preference.create to verify item breakdown.
//
// Covers:
//   1. Single product, no shipping → 1 item in preference body.
//   2. Single product + shipping → 2 items (product + shipping line).
//   3. Three products + shipping → 4 items.
//   4. Items sum ≠ amountARS → throws with clear message.
//   5. No items (free-form amount) → falls back to global single-item (backward compat).

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  clearMockModules,
  resetSourceModules,
  setMockModule,
} = require("../phase4/module-hooks.cjs");

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Builds the minimal params object that createMpPreference expects. */
function baseParams(overrides = {}) {
  return {
    accessToken: "TEST_TOKEN",
    amountARS: 500,
    description: "Venta Velora",
    businessId: "biz1aaaaaaaaaaaaaaaaaaaa",
    externalReference: "biz1aaaaaaaaaaaaaaaaaaaa:pi1aaa",
    ...overrides,
  };
}

/** Captured body args from calls to the mocked Preference.create. */
let capturedBodies = [];

/**
 * Builds a mock mercadopago module that captures the body passed to
 * Preference.create and returns a minimal valid MP preference response.
 */
function makeMpSdkMock() {
  capturedBodies = [];
  return {
    MercadoPagoConfig: class {
      constructor(cfg) { this.accessToken = cfg.accessToken; }
    },
    Preference: class {
      constructor(_config) {}
      async create({ body }) {
        capturedBodies.push(body);
        return { id: "PREF_123", init_point: "https://mp.com/link" };
      }
    },
    Payment: class {
      constructor(_config) {}
      async search() {
        return { results: [], paging: { total: 0 } };
      }
    },
  };
}

function loadModule() {
  resetSourceModules();
  clearMockModules();

  setMockModule("@/lib/cloud-logger", { cloudLog: () => {} });
  setMockModule("@/lib/prisma", {
    prisma: {
      business: {
        findUnique: async () => ({ name: "Test Business" }),
      },
    },
  });

  // Mock the official SDK — body captured via Preference.create stub.
  setMockModule("mercadopago", makeMpSdkMock());

  return require(
    "../../src/app/api/agents/payments/jsonrpc/_lib/mp-api-helpers.ts"
  );
}

// ── 1. Single product, no shipping → 1 item ──────────────────────────────────

test("createMpPreference — 1 product, no shipping → 1 item in preference", async () => {
  const { createMpPreference } = loadModule();

  const result = await createMpPreference(
    baseParams({
      amountARS: 500,
      items: [{ title: "alfajor", quantity: 1, unit_price: 500 }],
    }),
  );

  assert.ok(!("error" in result), `expected success, got: ${JSON.stringify(result)}`);
  assert.equal(capturedBodies.length, 1);

  const { items } = capturedBodies[0];
  assert.equal(items.length, 1);
  assert.equal(items[0].title, "alfajor");
  assert.equal(items[0].quantity, 1);
  assert.equal(items[0].unit_price, 500);
  assert.equal(items[0].currency_id, "ARS");
});

// ── 2. Single product + shipping → 2 items ────────────────────────────────────

test("createMpPreference — 1 product + shipping → 2 items (product + shipping line)", async () => {
  const { createMpPreference } = loadModule();

  const result = await createMpPreference(
    baseParams({
      amountARS: 800,
      items: [{ title: "alfajor", quantity: 1, unit_price: 500 }],
      shipping: { cost: 300, label: "Envío Andreani Mendoza" },
    }),
  );

  assert.ok(!("error" in result), `expected success, got: ${JSON.stringify(result)}`);

  const { items } = capturedBodies[0];
  assert.equal(items.length, 2);

  const productItem = items[0];
  assert.equal(productItem.title, "alfajor");
  assert.equal(productItem.unit_price, 500);

  const shippingItem = items[1];
  assert.equal(shippingItem.title, "Envío Andreani Mendoza");
  assert.equal(shippingItem.unit_price, 300);
  assert.equal(shippingItem.quantity, 1);
  assert.equal(shippingItem.currency_id, "ARS");
});

// ── 3. Three products + shipping → 4 items ────────────────────────────────────

test("createMpPreference — 3 products + shipping → 4 items total", async () => {
  const { createMpPreference } = loadModule();

  const result = await createMpPreference(
    baseParams({
      amountARS: 1_450,
      items: [
        { title: "alfajor", quantity: 2, unit_price: 200 },   // 400
        { title: "gaseosa", quantity: 1, unit_price: 350 },   // 350
        { title: "galletitas", quantity: 1, unit_price: 500 }, // 500
      ],
      shipping: { cost: 200, label: "Envío Correo Argentino" }, // 200
    }),
  );

  assert.ok(!("error" in result), `expected success, got: ${JSON.stringify(result)}`);

  const { items } = capturedBodies[0];
  assert.equal(items.length, 4, `expected 4 items, got ${items.length}: ${JSON.stringify(items)}`);

  // All items must have currency_id.
  for (const item of items) {
    assert.equal(item.currency_id, "ARS");
  }

  const shippingItem = items[3];
  assert.equal(shippingItem.title, "Envío Correo Argentino");
  assert.equal(shippingItem.unit_price, 200);
});

// ── 4. Sum mismatch → throws ──────────────────────────────────────────────────

test("createMpPreference — items sum ≠ amountARS → throws with clear message", async () => {
  const { createMpPreference } = loadModule();

  // items total = 400 + 300 = 700, but amountARS = 800 → mismatch
  await assert.rejects(
    () =>
      createMpPreference(
        baseParams({
          amountARS: 800,
          items: [
            { title: "alfajor", quantity: 1, unit_price: 400 },
            { title: "gaseosa", quantity: 1, unit_price: 300 },
          ],
          // no shipping
        }),
      ),
    (err) => {
      assert.ok(err instanceof Error, "should throw an Error");
      assert.ok(
        err.message.includes("700") || err.message.includes("800"),
        `message should mention both amounts: ${err.message}`,
      );
      return true;
    },
  );
});

// ── 5. No items (free-form amount) → global single-item fallback ──────────────

test("createMpPreference — no items → falls back to global single-item (backward compat)", async () => {
  const { createMpPreference } = loadModule();

  // Legacy caller: no items array, just amountARS + description
  const result = await createMpPreference(
    baseParams({
      amountARS: 1_200,
      description: "Venta Velora libre",
    }),
  );

  assert.ok(!("error" in result), `expected success, got: ${JSON.stringify(result)}`);

  const { items } = capturedBodies[0];
  assert.equal(items.length, 1, "fallback should produce exactly 1 global item");
  assert.equal(items[0].unit_price, 1_200);
  assert.equal(items[0].quantity, 1);
  assert.equal(items[0].currency_id, "ARS");
});
