// Unit test — registerPromesaSaleUseCase: unitPriceOverride >10× rejection (NABAOS M2).
//
// Correction 2 of batch-minor-fixes JD: the previous code silently clamped
// override > 10× dbPrice to dbPrice, charging a different amount than discussed.
// The correct behavior is to REJECT the operation so the caller is forced to
// correct the price before retrying.
//
// This test validates:
//   1. override > 10× dbPrice → outcome "unit_price_out_of_range", productId included.
//   2. override ≤ 10× dbPrice → guard does NOT fire (passes through).
//   3. No override at all → guard does NOT fire (uses DB price).

"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  clearMockModules,
  resetSourceModules,
  setMockModule,
} = require("../phase4/module-hooks.cjs");

// ── Shared mock builder ────────────────────────────────────────────────────────

function buildMocks({ productPrice = 100 } = {}) {
  const prismaMock = {
    paymentIntent: {
      // No existing record → not a replay
      findFirst: async () => null,
    },
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
    $transaction: async (fn) => fn(prismaMock),
  };

  return { prismaMock };
}

function loadUseCase({ prismaMock }) {
  resetSourceModules();
  clearMockModules();
  setMockModule("@/lib/prisma", { prisma: prismaMock });
  setMockModule("@/lib/cloud-logger", { cloudLog: () => {} });
  setMockModule("@/app/api/_lib/mutation-contract", {
    getServerActionMeta: () => ({ actionType: "payment_intent.register_promesa_sale", routeScope: "api", resourceType: "PaymentIntent" }),
  });
  setMockModule("@/infrastructure/shared/critical-write-audit", {
    recordCriticalWriteEvent: async () => {},
  });
  // Stub the entire payment-intent-post-confirm subsystem — this module has a
  // deep transitive chain through whatsapp → @velora/core-utils packages that
  // are not installed in the test runner. The guard we are testing fires BEFORE
  // any post-confirm logic, so stubbing the entire module is safe and correct.
  setMockModule("@velora/core-utils/jsonrpc-types", {});
  setMockModule("@velora/core-utils/mp-token-cipher", {});
  setMockModule("@/infrastructure/crypto/mp-token-cipher", {});
  setMockModule("@/lib/whatsapp-meta-credentials", {});
  setMockModule("@/lib/whatsapp-meta", { sendWhatsAppMessage: async () => {} });
  setMockModule("@/lib/whatsapp", { sendCustomerMessage: async () => {} });
  setMockModule("@/app/api/payment-intents/_lib/trigger-fiscal-receipt", {
    triggerFiscalReceipt: async () => {},
  });
  setMockModule("@/app/api/payment-intents/_lib/payment-intent-post-confirm.link", {
    runPostConfirmLinkEffects: async () => {},
  });
  setMockModule("@/app/api/payment-intents/_lib/notify-customer-on-confirm", {
    notifyCustomerOnConfirm: async () => {},
  });
  setMockModule("@/app/api/payment-intents/_lib/payment-intent-post-confirm", {
    runPostConfirmSideEffects: async () => {},
  });
  // Transaction body is not reached when the guard fires — stub throws to catch accidental calls.
  setMockModule("@/app/api/payment-intents/_lib/register-promesa-sale.transaction", {
    runPromesaSaleTransaction: async () => {
      throw new Error("runPromesaSaleTransaction must NOT be called when unit-price guard fires");
    },
  });
  return require("../../src/app/api/payment-intents/_lib/register-promesa-sale-use-case.ts");
}

const baseInput = {
  businessId: "biz-001",
  actorUserId: "user-001",
  customerId: "cust-001",
  expectedAt: new Date("2026-12-31T00:00:00.000Z"),
};

// ── Tests ──────────────────────────────────────────────────────────────────────

test("unit-price guard (promesa): override=1100 > 100*10 → outcome unit_price_out_of_range", async () => {
  const { prismaMock } = buildMocks({ productPrice: 100 });
  const { registerPromesaSaleUseCase } = loadUseCase({ prismaMock });

  const result = await registerPromesaSaleUseCase({
    ...baseInput,
    items: [{ productId: "prod-001", quantity: 1, unitPriceOverride: 1100 }],
  });

  assert.equal(result.outcome, "unit_price_out_of_range", "must reject >10× override");
  assert.equal("productId" in result ? result.productId : "", "prod-001", "must include offending productId");
});

test("unit-price guard (promesa): override=1000 (exactly 100*10) → passes through (boundary)", async () => {
  // Exactly 10× is NOT out-of-range (guard is >, not >=).
  const { prismaMock } = buildMocks({ productPrice: 100 });

  // At the boundary the guard passes; the tx stub throws to simulate the rest of
  // the pipeline. The point is the guard does NOT fire for exactly 10×.
  prismaMock.$transaction = async () => {
    throw Object.assign(new Error("BUSINESS_NOT_FOUND"), { tag: "BUSINESS_NOT_FOUND" });
  };

  const { registerPromesaSaleUseCase } = loadUseCase({ prismaMock });

  const result = await registerPromesaSaleUseCase({
    ...baseInput,
    items: [{ productId: "prod-001", quantity: 1, unitPriceOverride: 1000 }],
  });

  // Guard did NOT fire — outcome from the tx throw
  assert.equal(result.outcome, "business_not_found", "boundary 10× must not be blocked");
});

test("unit-price guard (promesa): override=50 (< dbPrice=100) → passes (legit discount)", async () => {
  const { prismaMock } = buildMocks({ productPrice: 100 });

  prismaMock.$transaction = async () => {
    throw Object.assign(new Error("BUSINESS_NOT_FOUND"), { tag: "BUSINESS_NOT_FOUND" });
  };

  const { registerPromesaSaleUseCase } = loadUseCase({ prismaMock });

  const result = await registerPromesaSaleUseCase({
    ...baseInput,
    items: [{ productId: "prod-001", quantity: 1, unitPriceOverride: 50 }],
  });

  assert.equal(result.outcome, "business_not_found", "discount override must not be blocked");
});

test("unit-price guard (promesa): no override → guard does not fire", async () => {
  const { prismaMock } = buildMocks({ productPrice: 100 });

  prismaMock.$transaction = async () => {
    throw Object.assign(new Error("BUSINESS_NOT_FOUND"), { tag: "BUSINESS_NOT_FOUND" });
  };

  const { registerPromesaSaleUseCase } = loadUseCase({ prismaMock });

  const result = await registerPromesaSaleUseCase({
    ...baseInput,
    items: [{ productId: "prod-001", quantity: 2 }],
  });

  assert.equal(result.outcome, "business_not_found", "no-override path must not be blocked");
});
