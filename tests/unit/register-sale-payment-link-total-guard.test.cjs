// Unit test — registerSaleWithPaymentLinkUseCase: pre-commit total guard.
//
// Fix A (Q7): the use-case must return outcome="invalid_total" when grandTotal
// is zero or NaN — BEFORE any PaymentIntent is created — so no orphan PI row
// is left in the DB after a validation failure.
//
// Industry-standard sourcing:
//   Brandur / Stripe canonical 2026 — validate ALL inputs before the first
//   irreversible DB write. See: https://brandur.org/idempotency-keys
//
// This test validates:
//   1. product.price = 0 → grandTotal = 0 → outcome "invalid_total", idempotency released.
//   2. valid product prices → outcome flows past the guard (falls through to tx).
//   3. The idempotency record is released when the guard fires (no orphan record).

"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  clearMockModules,
  resetSourceModules,
  setMockModule,
} = require("../phase4/module-hooks.cjs");

// ── Shared mock builder ────────────────────────────────────────────────────────

function buildMocks({ productPrice = 100, shippingCostARS = null } = {}) {
  const released = { count: 0 };
  const completed = { count: 0 };

  const idempotencyRecord = { kind: "execute", recordId: "idem-rec-001" };

  const prismaMock = {
    customer: {
      findFirst: async () => ({
        id: "cust-001",
        name: "Test Customer",
        email: null,
        phone: null,
        taxId: null,
        dni: null,
        address: null,
        postalCode: null,
        city: null,
      }),
    },
    product: {
      findMany: async () => [
        {
          id: "prod-001",
          name: "Widget",
          price: productPrice,
          businessId: "biz-001",
          quantity: 99,
        },
      ],
    },
    paymentIntent: {
      findFirst: async () => null,
    },
    $transaction: async (fn) => fn(prismaMock),
  };

  const idempotencyMock = {
    beginIdempotentMutation: async () => idempotencyRecord,
    completeIdempotentMutation: async () => { completed.count++; },
    releaseIdempotentMutation: async () => { released.count++; },
  };

  return { prismaMock, idempotencyMock, released, completed };
}

function loadUseCase({ prismaMock, idempotencyMock }) {
  resetSourceModules();
  clearMockModules();
  setMockModule("@/lib/prisma", { prisma: prismaMock });
  setMockModule("@/lib/cloud-logger", { cloudLog: () => {} });
  setMockModule("@/app/api/_lib/mutation-contract", {
    getServerActionMeta: () => ({ actionType: "payment_intent.create_link", routeScope: "api", resourceType: "PaymentIntent" }),
  });
  setMockModule("@/app/api/_lib/idempotency", idempotencyMock);
  setMockModule("@/infrastructure/shared/critical-write-audit", {
    recordCriticalWriteEvent: async () => {},
  });
  // Transaction body is not reached when total guard fires — stub is a no-op.
  setMockModule("@/app/api/payment-intents/_lib/register-sale-with-payment-link.transaction", {
    runSaleWithPaymentLinkTransaction: async () => {
      throw new Error("runSaleWithPaymentLinkTransaction must NOT be called when total guard fires");
    },
  });
  return require("../../src/app/api/payment-intents/_lib/register-sale-with-payment-link-use-case.ts");
}

// ── Tests ──────────────────────────────────────────────────────────────────────

test("total guard: product.price=0 → grandTotal=0 → outcome invalid_total (no tx)", async () => {
  const { prismaMock, idempotencyMock, released } = buildMocks({ productPrice: 0 });
  const { registerSaleWithPaymentLinkUseCase } = loadUseCase({ prismaMock, idempotencyMock });

  const result = await registerSaleWithPaymentLinkUseCase({
    businessId: "biz-001",
    actorUserId: "user-001",
    customerId: "cust-001",
    items: [{ productId: "prod-001", quantity: 1 }],
    description: "Test link",
    idempotencyKey: "key-zero-price",
  });

  assert.equal(result.outcome, "invalid_total", "must return invalid_total when grandTotal=0");
  assert.equal(released.count, 1, "idempotency record must be released exactly once");
});

test("total guard: valid product.price=100 → grandTotal=100 → guard passes (tx reached)", async () => {
  // With valid price, the guard passes. The tx stub throws — expected, because
  // we are not wiring the full transaction. The point is the guard itself is clear.
  const { prismaMock, idempotencyMock, released } = buildMocks({ productPrice: 100 });

  // Override tx mock to succeed (simulate a valid flow reaching the tx)
  prismaMock.$transaction = async () => {
    throw Object.assign(new Error("BUSINESS_NOT_FOUND"), { tag: "BUSINESS_NOT_FOUND" });
  };

  const { registerSaleWithPaymentLinkUseCase } = loadUseCase({ prismaMock, idempotencyMock });

  const result = await registerSaleWithPaymentLinkUseCase({
    businessId: "biz-001",
    actorUserId: "user-001",
    customerId: "cust-001",
    items: [{ productId: "prod-001", quantity: 1 }],
    description: "Test link",
    idempotencyKey: "key-valid-price",
  });

  // Guard did NOT fire — flow passed to tx which threw BUSINESS_NOT_FOUND.
  assert.equal(result.outcome, "business_not_found", "guard must NOT fire for valid total");
  // Idempotency was released due to the tx error (not the guard).
  assert.equal(released.count, 1, "idempotency released on tx error");
});

test("total guard: outcome-map maps invalid_total to tool error response", () => {
  resetSourceModules();
  clearMockModules();
  setMockModule("@/app/api/payment-intents/_lib/register-sale-with-payment-link-use-case", {
    // Type-only import — no need to mock the function itself for the outcome-map test.
  });
  const { mapRegisterSaleOutcomeToError } = require("../../src/app/api/agents/payments/jsonrpc/_lib/payments-agent-tools.outcome-map.ts");

  const result = mapRegisterSaleOutcomeToError({ outcome: "invalid_total" });

  assert.ok(result !== null, "outcome-map must return an error for invalid_total");
  assert.equal(result.error, "invalid_total");
  assert.equal(result.currency, "ARS");
  assert.ok(typeof result.message === "string" && result.message.length > 0, "must include a human-readable message");
});

// ── unitPriceOverride >10× rejection (NABAOS M2) ──────────────────────────────

test("unit-price guard: override=1100 > 100*10 → outcome unit_price_out_of_range, idempotency released", async () => {
  const { prismaMock, idempotencyMock, released } = buildMocks({ productPrice: 100 });
  const { registerSaleWithPaymentLinkUseCase } = loadUseCase({ prismaMock, idempotencyMock });

  const result = await registerSaleWithPaymentLinkUseCase({
    businessId: "biz-001",
    actorUserId: "user-001",
    customerId: "cust-001",
    items: [{ productId: "prod-001", quantity: 1, unitPriceOverride: 1100 }],
    description: "Test link with bad override",
    idempotencyKey: "key-price-out-of-range",
  });

  assert.equal(result.outcome, "unit_price_out_of_range", "must reject >10× override");
  assert.equal("productId" in result ? result.productId : "", "prod-001", "must include offending productId");
  assert.equal(released.count, 1, "idempotency record must be released on rejection");
});

test("unit-price guard: override=999 (≤100*10) → passes through (not rejected)", async () => {
  // 999 ≤ 100 * 10 = 1000 → valid override; guard must NOT fire.
  const { prismaMock, idempotencyMock, released } = buildMocks({ productPrice: 100 });

  // Override tx mock to succeed (simulate a valid flow reaching the tx)
  prismaMock.$transaction = async () => {
    throw Object.assign(new Error("BUSINESS_NOT_FOUND"), { tag: "BUSINESS_NOT_FOUND" });
  };

  const { registerSaleWithPaymentLinkUseCase } = loadUseCase({ prismaMock, idempotencyMock });

  const result = await registerSaleWithPaymentLinkUseCase({
    businessId: "biz-001",
    actorUserId: "user-001",
    customerId: "cust-001",
    items: [{ productId: "prod-001", quantity: 1, unitPriceOverride: 999 }],
    description: "Test link with legit override",
    idempotencyKey: "key-price-in-range",
  });

  // Guard did NOT fire — outcome comes from the tx throw (business_not_found)
  assert.equal(result.outcome, "business_not_found", "legit override must not be blocked");
  // Idempotency released by the tx error, NOT the price guard
  assert.equal(released.count, 1, "idempotency released by tx error, not the guard");
});

test("unit-price guard: outcome-map maps unit_price_out_of_range to tool error response", () => {
  resetSourceModules();
  clearMockModules();
  setMockModule("@/app/api/payment-intents/_lib/register-sale-with-payment-link-use-case", {});
  const { mapRegisterSaleOutcomeToError } = require("../../src/app/api/agents/payments/jsonrpc/_lib/payments-agent-tools.outcome-map.ts");

  const result = mapRegisterSaleOutcomeToError({ outcome: "unit_price_out_of_range", productId: "prod-001" });

  assert.ok(result !== null, "outcome-map must return an error for unit_price_out_of_range");
  assert.equal(result.error, "unit_price_out_of_range");
  assert.equal(result.currency, "ARS");
  assert.ok(typeof result.message === "string" && result.message.length > 0, "must include a human-readable message");
});
