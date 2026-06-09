// Unit tests for the onboarding setupComplete / onboardingComplete logic
// extracted from owner-handler.ts (Fix 1: removed openingCashSet requirement).
//
// These tests exercise the pure boolean logic — no DB, no network.
// Pattern follows the existing tests/unit/*.test.cjs cjs convention.

const assert = require("node:assert/strict");
const test = require("node:test");

// ── Pure helper — mirrors the logic in owner-handler.ts ─────────────────────

/**
 * @param {{ businessNameSet: boolean, businessTypeSet: boolean, paymentMethodsSet: boolean, productCount: number }} biz
 */
function computeOnboardingComplete(biz) {
  // Mirrors: owner-handler.ts setupComplete + onboardingComplete
  const setupComplete =
    biz.businessNameSet && biz.businessTypeSet && biz.paymentMethodsSet;
  return setupComplete && biz.productCount > 0;
}

// ── setupComplete variations ─────────────────────────────────────────────────

test("setupComplete: true when name+type+payment set regardless of openingCash", () => {
  assert.equal(
    computeOnboardingComplete({
      businessNameSet: true,
      businessTypeSet: true,
      paymentMethodsSet: true,
      productCount: 1,
    }),
    true,
    "fully onboarded business must return true",
  );
});

test("setupComplete: false when name missing", () => {
  assert.equal(
    computeOnboardingComplete({
      businessNameSet: false,
      businessTypeSet: true,
      paymentMethodsSet: true,
      productCount: 1,
    }),
    false,
  );
});

test("setupComplete: false when type missing", () => {
  assert.equal(
    computeOnboardingComplete({
      businessNameSet: true,
      businessTypeSet: false,
      paymentMethodsSet: true,
      productCount: 1,
    }),
    false,
  );
});

test("setupComplete: false when payment methods missing", () => {
  assert.equal(
    computeOnboardingComplete({
      businessNameSet: true,
      businessTypeSet: true,
      paymentMethodsSet: false,
      productCount: 1,
    }),
    false,
  );
});

// ── onboardingComplete: products required ────────────────────────────────────

test("onboardingComplete: false when productCount is 0 even if setup done", () => {
  assert.equal(
    computeOnboardingComplete({
      businessNameSet: true,
      businessTypeSet: true,
      paymentMethodsSet: true,
      productCount: 0,
    }),
    false,
    "at least 1 product required for onboardingComplete",
  );
});

test("onboardingComplete: true with name+type+payment+1 product", () => {
  assert.equal(
    computeOnboardingComplete({
      businessNameSet: true,
      businessTypeSet: true,
      paymentMethodsSet: true,
      productCount: 1,
    }),
    true,
  );
});

test("onboardingComplete: true with multiple products", () => {
  assert.equal(
    computeOnboardingComplete({
      businessNameSet: true,
      businessTypeSet: true,
      paymentMethodsSet: true,
      productCount: 5,
    }),
    true,
  );
});

// ── Regression: new business (openingCash never set) must not be stuck ───────

test("regression: new business with openingCashSet=false is NOT permanently blocked", () => {
  // Before Fix 1, setupComplete required openingCashSet. A new business created
  // after Fase B removal would have openingCashSet=false forever, making the
  // Supervisor think it is perpetually mid-onboarding.
  // The fix: openingCashSet is NOT part of the completion check.
  const newBusiness = {
    businessNameSet: true,
    businessTypeSet: true,
    paymentMethodsSet: true,
    // openingCashSet intentionally absent — not in the signature
    productCount: 1,
  };
  assert.equal(
    computeOnboardingComplete(newBusiness),
    true,
    "new business (no openingCash) must complete onboarding once name+type+payment+product are set",
  );
});
