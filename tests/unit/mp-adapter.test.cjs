"use strict";

// Unit tests for MercadoPagoAdapter (payment-provider abstraction, Fase A2).
//
// Covers:
//   1. createCollection — happy path: calls getMpTokenForBusiness + createMpPreference,
//      writes providerRef via PaymentIntentRepositoryPort.patchCheckout (not inline prisma),
//      returns CollectionResult.
//   2. createCollection — payment_provider_not_connected: short-circuits before any MP call.
//   3. createCollection — MP preference error: propagates error from createMpPreference.
//   4. getStatus — happy path: reads providerRef from DB, calls getMpPaymentStatusByPreference.
//   5. getStatus — payment_provider_not_connected: returns error immediately.
//   6. getStatus — no_providerRef (DB row missing providerRef): returns error.
//   7. getStatus — status mapping: "approved", "rejected", and other → "pending".
//   8. createCollection — port wiring: patchCheckout called on port, NOT inline prisma.updateMany.
//   9. createCollection — DB error via port: returns { error: "patch_failed", detail: { duplicatePreferenceId } }.
//  10. createCollection — CAS miss (count=0): still returns CollectionResult (no DB error, just a WARN log).

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  clearMockModules,
  resetSourceModules,
  setMockModule,
} = require("../phase4/module-hooks.cjs");

// ── Helpers ───────────────────────────────────────────────────────────────────

const BIZ_ID = "biz1aaaaaaaaaaaaaaaaaaaa";
const PI_ID = "pi1aaaaaaaaaaaaaaaaaaaa1";

/** Builds a minimal fake Prisma for getStatus (findFirst only — no write needed). */
function makeFakePrismaReadOnly({ providerRef = null, bizId = BIZ_ID } = {}) {
  return {
    business: {
      findUnique: async () => ({ paymentProvider: "mercadopago" }),
    },
    paymentIntent: {
      // getStatus uses findFirst — kept on the prisma singleton since getStatus
      // is out of scope for this slice. Tests that need it set it up here.
      findFirst: async ({ where }) => {
        if (where.id !== PI_ID) return null;
        if (where.businessId !== undefined && where.businessId !== bizId) return null;
        return { providerRef };
      },
    },
  };
}

/**
 * Builds a mock PaymentIntentRepositoryPort for createCollection tests.
 * Tracks calls and lets tests control the resolved { count } or throw.
 */
function makeFakePaymentIntentRepository({ count = 1, shouldThrow = false } = {}) {
  const patchCheckoutCalls = [];
  return {
    _patchCheckoutCalls: patchCheckoutCalls,
    patchCheckout: async (args) => {
      patchCheckoutCalls.push(args);
      if (shouldThrow) {
        const err = new Error("DB connection error");
        err.code = "P1001";
        throw err;
      }
      return { count };
    },
    findByIdAndBusiness: async () => null,
  };
}

function loadAdapter(mocks) {
  resetSourceModules();
  clearMockModules();
  // Always stub these heavy imports first.
  setMockModule("@/lib/cloud-logger", { cloudLog: () => {} });
  for (const [key, val] of Object.entries(mocks)) {
    setMockModule(key, val);
  }
  return require(
    "../../src/app/api/agents/payments/jsonrpc/_lib/providers/mp-adapter.ts"
  );
}

// ── 1. createCollection — happy path ─────────────────────────────────────────

test("createCollection — happy path: returns CollectionResult with checkoutUrl + providerRef", async () => {
  const repo = makeFakePaymentIntentRepository({ count: 1 });
  // prisma still needed for getStatus (findFirst) — not called in createCollection after wiring
  const prisma = makeFakePrismaReadOnly();
  const { MercadoPagoAdapter } = loadAdapter({
    "@/lib/prisma": { prisma },
    "@/infrastructure/persistence/prisma-payment-intent.repository": {
      prismaPaymentIntentRepository: repo,
    },
    "../mp-api-helpers": {
      getMpTokenForBusiness: async () => "tok-abc",
      createMpPreference: async () => ({
        preferenceId: "pref-xyz",
        checkoutUrl: "https://mp.com/pay/pref-xyz",
      }),
      getMpPaymentStatusByPreference: async () => ({ status: "pending", paymentId: null, detail: {} }),
    },
  });

  const adapter = new MercadoPagoAdapter();
  const result = await adapter.createCollection({
    paymentIntentId: PI_ID,
    amountARS: 10_000,
    description: "Venta test",
    customerName: "Ana Test",
    businessId: BIZ_ID,
  });

  assert.ok(!("error" in result), `should not have error, got: ${JSON.stringify(result)}`);
  assert.equal(result.paymentIntentId, PI_ID);
  assert.equal(result.amountARS, 10_000);
  assert.equal(result.checkoutUrl, "https://mp.com/pay/pref-xyz");
  assert.equal(result.providerRef, "pref-xyz");
  assert.equal(result.status, "pending");
  assert.equal(result.currency, "ARS");
  // Defense-in-depth (JD finding): the happy path MUST actually invoke the port write-back.
  assert.equal(repo._patchCheckoutCalls.length, 1, "patchCheckout must be called on the happy path");
});

// ── 2. createCollection — no token ───────────────────────────────────────────

test("createCollection — payment_provider_not_connected: short-circuits before calling createMpPreference", async () => {
  const repo = makeFakePaymentIntentRepository();
  const prisma = makeFakePrismaReadOnly();
  let mpCalled = false;
  const { MercadoPagoAdapter } = loadAdapter({
    "@/lib/prisma": { prisma },
    "@/infrastructure/persistence/prisma-payment-intent.repository": {
      prismaPaymentIntentRepository: repo,
    },
    "../mp-api-helpers": {
      getMpTokenForBusiness: async () => null,
      createMpPreference: async () => { mpCalled = true; return { preferenceId: "x", checkoutUrl: "x" }; },
      getMpPaymentStatusByPreference: async () => ({ status: "pending", paymentId: null, detail: {} }),
    },
  });

  const adapter = new MercadoPagoAdapter();
  const result = await adapter.createCollection({
    paymentIntentId: PI_ID,
    amountARS: 5_000,
    description: "desc",
    businessId: BIZ_ID,
  });

  assert.ok("error" in result, "should return error object");
  assert.equal(result.error, "payment_provider_not_connected");
  assert.equal(mpCalled, false, "createMpPreference must NOT be called");
  assert.equal(repo._patchCheckoutCalls.length, 0, "port must NOT be called");
});

// ── 3. createCollection — MP preference API error ────────────────────────────

test("createCollection — MP preference API error: propagates error from createMpPreference", async () => {
  const repo = makeFakePaymentIntentRepository();
  const prisma = makeFakePrismaReadOnly();
  const { MercadoPagoAdapter } = loadAdapter({
    "@/lib/prisma": { prisma },
    "@/infrastructure/persistence/prisma-payment-intent.repository": {
      prismaPaymentIntentRepository: repo,
    },
    "../mp-api-helpers": {
      getMpTokenForBusiness: async () => "tok-abc",
      createMpPreference: async () => ({ error: "mp_api_error", detail: { status: 500 } }),
      getMpPaymentStatusByPreference: async () => ({ status: "pending", paymentId: null, detail: {} }),
    },
  });

  const adapter = new MercadoPagoAdapter();
  const result = await adapter.createCollection({
    paymentIntentId: PI_ID,
    amountARS: 5_000,
    description: "desc",
    businessId: BIZ_ID,
  });

  assert.ok("error" in result);
  assert.equal(result.error, "mp_api_error");
  assert.equal(repo._patchCheckoutCalls.length, 0, "port must NOT be called if MP fails");
});

// ── 4. getStatus — happy path ────────────────────────────────────────────────

test("getStatus — happy path: reads providerRef from DB, calls getMpPaymentStatusByPreference", async () => {
  const prisma = makeFakePrismaReadOnly({ providerRef: "pref-xyz" });
  const { MercadoPagoAdapter } = loadAdapter({
    "@/lib/prisma": { prisma },
    "@/infrastructure/persistence/prisma-payment-intent.repository": {
      prismaPaymentIntentRepository: makeFakePaymentIntentRepository(),
    },
    "../mp-api-helpers": {
      getMpTokenForBusiness: async () => "tok-abc",
      createMpPreference: async () => ({ preferenceId: "x", checkoutUrl: "x" }),
      getMpPaymentStatusByPreference: async ({ preferenceId }) => ({
        status: "approved",
        paymentId: "pay-001",
        detail: { preferenceId },
      }),
    },
  });

  const adapter = new MercadoPagoAdapter();
  const result = await adapter.getStatus({ paymentIntentId: PI_ID, businessId: BIZ_ID });

  assert.equal(result.status, "approved");
  assert.equal(result.paymentIntentId, PI_ID);
  assert.equal(result.providerRef, "pay-001");
  assert.equal(result.currency, "ARS");
});

// ── 5. getStatus — no token ───────────────────────────────────────────────────

test("getStatus — payment_provider_not_connected: returns error immediately", async () => {
  const prisma = makeFakePrismaReadOnly({ providerRef: "pref-xyz" });
  let statusCalled = false;
  const { MercadoPagoAdapter } = loadAdapter({
    "@/lib/prisma": { prisma },
    "@/infrastructure/persistence/prisma-payment-intent.repository": {
      prismaPaymentIntentRepository: makeFakePaymentIntentRepository(),
    },
    "../mp-api-helpers": {
      getMpTokenForBusiness: async () => null,
      createMpPreference: async () => ({ preferenceId: "x", checkoutUrl: "x" }),
      getMpPaymentStatusByPreference: async () => { statusCalled = true; return { status: "pending", paymentId: null, detail: {} }; },
    },
  });

  const adapter = new MercadoPagoAdapter();
  const result = await adapter.getStatus({ paymentIntentId: PI_ID, businessId: BIZ_ID });

  assert.equal(result.status, "error");
  assert.ok(String(result.detail).includes("payment_provider_not_connected"));
  assert.equal(statusCalled, false);
});

// ── 6. getStatus — null providerRef (pre-migration intent) ───────────────────

test("getStatus — null providerRef (pre-migration intent): returns error with intent_sin_provider_ref detail", async () => {
  const prisma = makeFakePrismaReadOnly({ providerRef: null });
  const { MercadoPagoAdapter } = loadAdapter({
    "@/lib/prisma": { prisma },
    "@/infrastructure/persistence/prisma-payment-intent.repository": {
      prismaPaymentIntentRepository: makeFakePaymentIntentRepository(),
    },
    "../mp-api-helpers": {
      getMpTokenForBusiness: async () => "tok-abc",
      createMpPreference: async () => ({ preferenceId: "x", checkoutUrl: "x" }),
      getMpPaymentStatusByPreference: async () => ({ status: "pending", paymentId: null, detail: {} }),
    },
  });

  const adapter = new MercadoPagoAdapter();
  const result = await adapter.getStatus({ paymentIntentId: PI_ID, businessId: BIZ_ID });

  assert.equal(result.status, "error");
  // Must distinguish pre-migration nulls from actual broken lookups.
  assert.equal(result.detail, "intent_sin_provider_ref");
});

// ── getStatus — cross-tenant isolation ────────────────────────────────────────

test("getStatus — wrong businessId: returns intent_not_found (tenant isolation)", async () => {
  const prisma = makeFakePrismaReadOnly({ providerRef: "pref-xyz" });
  const { MercadoPagoAdapter } = loadAdapter({
    "@/lib/prisma": { prisma },
    "@/infrastructure/persistence/prisma-payment-intent.repository": {
      prismaPaymentIntentRepository: makeFakePaymentIntentRepository(),
    },
    "../mp-api-helpers": {
      getMpTokenForBusiness: async () => "tok-abc",
      createMpPreference: async () => ({ preferenceId: "x", checkoutUrl: "x" }),
      getMpPaymentStatusByPreference: async () => ({ status: "approved", paymentId: "pay-x", detail: {} }),
    },
  });

  const adapter = new MercadoPagoAdapter();
  const result = await adapter.getStatus({ paymentIntentId: PI_ID, businessId: "biz-other-aaaaaaaaaaaaa" });

  assert.equal(result.status, "error");
  assert.equal(result.detail, "intent_not_found", "must not return data for a different businessId");
});

// ── 7. getStatus — status mapping ────────────────────────────────────────────

test("getStatus — status mapping: 'rejected' maps to rejected", async () => {
  const prisma = makeFakePrismaReadOnly({ providerRef: "pref-rej" });
  const { MercadoPagoAdapter } = loadAdapter({
    "@/lib/prisma": { prisma },
    "@/infrastructure/persistence/prisma-payment-intent.repository": {
      prismaPaymentIntentRepository: makeFakePaymentIntentRepository(),
    },
    "../mp-api-helpers": {
      getMpTokenForBusiness: async () => "tok-abc",
      createMpPreference: async () => ({ preferenceId: "x", checkoutUrl: "x" }),
      getMpPaymentStatusByPreference: async () => ({ status: "rejected", paymentId: "pay-rej", detail: {} }),
    },
  });

  const adapter = new MercadoPagoAdapter();
  const result = await adapter.getStatus({ paymentIntentId: PI_ID, businessId: BIZ_ID });
  assert.equal(result.status, "rejected");
});

// NOTE: status mapping (MP raw → VeloraPaymentStatus) was extracted to
// mp-status-mapping.ts and is applied inside getMpPaymentStatusByPreference
// (mp-status-helpers.ts), NOT inside the adapter itself. The adapter passes
// through the already-mapped VeloraPaymentStatus from the helper.
// This test verifies that the adapter correctly passes through "pending" when
// the helper returns it (which covers the in_process / in_mediation / pending
// MP statuses that mp-status-mapping.ts maps to "pending").
test("getStatus — status mapping: in_process (reviewing) passes through as 'pending'", async () => {
  const prisma = makeFakePrismaReadOnly({ providerRef: "pref-unk" });
  const { MercadoPagoAdapter } = loadAdapter({
    "@/lib/prisma": { prisma },
    "@/infrastructure/persistence/prisma-payment-intent.repository": {
      prismaPaymentIntentRepository: makeFakePaymentIntentRepository(),
    },
    "../mp-api-helpers": {
      getMpTokenForBusiness: async () => "tok-abc",
      createMpPreference: async () => ({ preferenceId: "x", checkoutUrl: "x" }),
      // Stub returns already-mapped VeloraPaymentStatus ("pending"), matching
      // what getMpPaymentStatusByPreference returns after mapping "in_process".
      getMpPaymentStatusByPreference: async () => ({ status: "pending", paymentId: null, detail: {} }),
    },
  });

  const adapter = new MercadoPagoAdapter();
  const result = await adapter.getStatus({ paymentIntentId: PI_ID, businessId: BIZ_ID });
  assert.equal(result.status, "pending");
});

// ── 8. PORT WIRING: patchCheckout called on port, NOT inline prisma.updateMany ─

test("createCollection — port wiring: patchCheckout called with correct args (CAS WHERE preserved)", async () => {
  const repo = makeFakePaymentIntentRepository({ count: 1 });
  const prisma = makeFakePrismaReadOnly();
  const { MercadoPagoAdapter } = loadAdapter({
    "@/lib/prisma": { prisma },
    "@/infrastructure/persistence/prisma-payment-intent.repository": {
      prismaPaymentIntentRepository: repo,
    },
    "../mp-api-helpers": {
      getMpTokenForBusiness: async () => "tok-abc",
      createMpPreference: async () => ({
        preferenceId: "pref-cas-test",
        checkoutUrl: "https://mp.com/pay/pref-cas-test",
      }),
      getMpPaymentStatusByPreference: async () => ({ status: "pending", paymentId: null, detail: {} }),
    },
  });

  const adapter = new MercadoPagoAdapter();
  const result = await adapter.createCollection({
    paymentIntentId: PI_ID,
    amountARS: 2_500,
    description: "Test CAS port wiring",
    businessId: BIZ_ID,
  });

  assert.ok(!("error" in result), `unexpected error: ${JSON.stringify(result)}`);
  assert.equal(repo._patchCheckoutCalls.length, 1, "patchCheckout must be called exactly once");
  const call = repo._patchCheckoutCalls[0];
  // CAS args: paymentIntentId + businessId (tenant scope) + providerRef + checkoutUrl
  assert.equal(call.paymentIntentId, PI_ID, "patchCheckout must receive the correct paymentIntentId");
  assert.equal(call.businessId, BIZ_ID, "patchCheckout must receive businessId (tenant CAS guard)");
  assert.equal(call.providerRef, "pref-cas-test", "patchCheckout must receive the MP preferenceId as providerRef");
  assert.equal(call.checkoutUrl, "https://mp.com/pay/pref-cas-test", "patchCheckout must receive the MP checkoutUrl");
});

// ── 9. ORPHAN GUARD: DB error via port → { error: "patch_failed", detail: { duplicatePreferenceId } } ─

test("createCollection — DB error via port: returns patch_failed with duplicatePreferenceId (orphan guard)", async () => {
  // The port throws on DB failure (it has no internal try/catch). The adapter's
  // try/catch MUST catch that throw and return { error: "patch_failed", detail: { duplicatePreferenceId } }
  // so ops can identify the orphaned MP preference for cleanup.
  // This is the NON-NEGOTIABLE orphan-preference constraint: a transient DB error
  // must NOT silently discard the preferenceId.
  const repo = makeFakePaymentIntentRepository({ shouldThrow: true });
  const prisma = makeFakePrismaReadOnly();
  const { MercadoPagoAdapter } = loadAdapter({
    "@/lib/prisma": { prisma },
    "@/infrastructure/persistence/prisma-payment-intent.repository": {
      prismaPaymentIntentRepository: repo,
    },
    "../mp-api-helpers": {
      getMpTokenForBusiness: async () => "tok-abc",
      createMpPreference: async () => ({
        preferenceId: "pref-orphan-123",
        checkoutUrl: "https://mp.com/pay/pref-orphan-123",
      }),
      getMpPaymentStatusByPreference: async () => ({ status: "pending", paymentId: null, detail: {} }),
    },
  });

  const adapter = new MercadoPagoAdapter();
  const result = await adapter.createCollection({
    paymentIntentId: PI_ID,
    amountARS: 3_000,
    description: "Test orphan guard",
    businessId: BIZ_ID,
  });

  assert.ok("error" in result, "must return error on DB failure");
  assert.equal(result.error, "patch_failed", "error code must be patch_failed");
  assert.ok(result.detail && typeof result.detail === "object", "detail must be an object");
  assert.equal(
    result.detail.duplicatePreferenceId,
    "pref-orphan-123",
    "detail.duplicatePreferenceId MUST preserve the MP preferenceId for ops cleanup",
  );
});

// ── 10. CAS MISS: count=0 → CollectionResult still returned (no error thrown, just WARN log) ─

test("createCollection — CAS miss (count=0): still returns CollectionResult, does NOT throw", async () => {
  // count=0 means another concurrent request already wrote providerRef (race-lost).
  // The adapter logs WARN but MUST NOT return an error — the existing providerRef is correct.
  const repo = makeFakePaymentIntentRepository({ count: 0 }); // CAS miss
  const prisma = makeFakePrismaReadOnly();
  const { MercadoPagoAdapter } = loadAdapter({
    "@/lib/prisma": { prisma },
    "@/infrastructure/persistence/prisma-payment-intent.repository": {
      prismaPaymentIntentRepository: repo,
    },
    "../mp-api-helpers": {
      getMpTokenForBusiness: async () => "tok-abc",
      createMpPreference: async () => ({
        preferenceId: "pref-race-winner",
        checkoutUrl: "https://mp.com/pay/pref-race-winner",
      }),
      getMpPaymentStatusByPreference: async () => ({ status: "pending", paymentId: null, detail: {} }),
    },
  });

  const adapter = new MercadoPagoAdapter();
  const result = await adapter.createCollection({
    paymentIntentId: PI_ID,
    amountARS: 1_000,
    description: "Test CAS miss",
    businessId: BIZ_ID,
  });

  // CAS miss (count=0) is a race lost, not an error — the adapter MUST still
  // return a valid CollectionResult so the caller can share the checkout URL.
  assert.ok(!("error" in result), `CAS miss must NOT return error, got: ${JSON.stringify(result)}`);
  assert.equal(result.status, "pending");
  assert.equal(result.checkoutUrl, "https://mp.com/pay/pref-race-winner");
});
