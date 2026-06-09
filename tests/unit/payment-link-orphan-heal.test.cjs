// Unit tests for payment-link-orphan-heal.ts
// Covers the intent_not_found path (missing DB row = corruption, not healthy replay)
// and the healthy-replay path (providerRef already set = skip provider call).
//
// Uses the prisma stub (tests/_stubs/prisma.js) which defaults all
// findFirst / findUnique calls to null — perfect for the missing-row case.

const assert = require("node:assert/strict");
const test = require("node:test");

// Stub cloud-logger to avoid pulling in the real GCP logger at test load time.
const Module = require("module");
const originalResolve = Module._resolveFilename;
const path = require("path");
const REPO_ROOT = path.resolve(__dirname, "..", "..");

// We need fine-grained control over prisma.paymentIntent.findFirst per test,
// so we build a thin override on top of the default stub.
let findFirstImpl = async () => null;

Module._resolveFilename = function (request, parent, ...rest) {
  if (request === "@/lib/cloud-logger" || request.endsWith(path.join("src", "lib", "cloud-logger.ts"))) {
    return path.join(REPO_ROOT, "tests", "_stubs", "cloud-logger.js");
  }
  if (request === "@/lib/prisma" || request.endsWith(path.join("src", "lib", "prisma.ts"))) {
    return path.join(REPO_ROOT, "tests", "_stubs", "prisma-orphan-override.js");
  }
  return originalResolve.call(this, request, parent, ...rest);
};

// Write the override stub inline via a require-time global so we can replace
// findFirstImpl per test without cache-busting the module.
// The override stub file is created below at test startup.
const fs = require("fs");
const overridePath = path.join(REPO_ROOT, "tests", "_stubs", "prisma-orphan-override.js");
// Write a stub that delegates findFirst to the global `__prismaFindFirst`.
fs.writeFileSync(
  overridePath,
  `
const prisma = {
  paymentIntent: {
    findFirst: async (...args) => global.__prismaFindFirst ? global.__prismaFindFirst(...args) : null,
    findUnique: async () => null,
    create: async () => ({}),
    update: async () => ({}),
  },
};
// Provide a Proxy for any other model access (e.g. business.findUnique)
const handler = { get(_, model) { return prisma[model] ?? { findFirst: async()=>null, findUnique: async()=>null, create:async()=>({}), update:async()=>({}) }; } };
module.exports = { prisma: new Proxy(prisma, handler) };
`,
);

// Also ensure cloud-logger stub exists.
const cloudLoggerStubPath = path.join(REPO_ROOT, "tests", "_stubs", "cloud-logger.js");
if (!fs.existsSync(cloudLoggerStubPath)) {
  fs.writeFileSync(cloudLoggerStubPath, "module.exports = { cloudLog: () => {} };\n");
}

// Now patch getPaymentProvider to be a no-op (never called in the tests we care about).
// We will override it via an additional Module._resolveFilename hook below.
const paymentProviderStubPath = path.join(REPO_ROOT, "tests", "_stubs", "payment-provider-stub.js");
fs.writeFileSync(
  paymentProviderStubPath,
  `module.exports = { getPaymentProvider: async () => ({ createCollection: async () => ({ providerRef: "pref_test", checkoutUrl: "https://mp.me/test", instructions: null }) }) };\n`,
);

// Extend the resolver for the payment-provider module.
const origResolve2 = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (
    request.endsWith("payment-provider") ||
    (typeof request === "string" && request.includes("payment-provider") && !request.endsWith(".test.cjs"))
  ) {
    return paymentProviderStubPath;
  }
  return origResolve2.call(this, request, parent, ...rest);
};

// Now load the module under test.
const { healOrphanedIntent } = require("../../src/app/api/agents/payments/jsonrpc/_lib/payment-link-orphan-heal.ts");

// Helpers
const BASE_PARAMS = {
  paymentIntentId: "intent_abc123",
  businessId: "biz_xyz456",
  description: "Venta Velora - 2 unidades",
  customerName: "Juan",
};

// ── intent_not_found — row missing from DB ───────────────────────────────────

test("healOrphanedIntent: returns { error: 'intent_not_found' } when DB row is missing", async () => {
  global.__prismaFindFirst = async () => null; // simulate missing row
  const result = await healOrphanedIntent(BASE_PARAMS);
  assert.ok("error" in result, "result should have an error key");
  assert.equal(result.error, "intent_not_found");
});

test("healOrphanedIntent: does NOT return { healed: false } when DB row is missing", async () => {
  global.__prismaFindFirst = async () => null;
  const result = await healOrphanedIntent(BASE_PARAMS);
  assert.ok(!("healed" in result), "should not return healed key for missing row");
});

// ── healthy replay — providerRef already set ─────────────────────────────────

test("healOrphanedIntent: returns { healed: false } when providerRef already set (healthy replay)", async () => {
  global.__prismaFindFirst = async () => ({ providerRef: "pref_existing", monto: { toNumber: () => 1500 } });
  const result = await healOrphanedIntent(BASE_PARAMS);
  assert.deepStrictEqual(result, { healed: false });
});

// ── orphaned intent — providerRef null, adapter called ───────────────────────

test("healOrphanedIntent: returns { healed: true } when providerRef is null and adapter succeeds", async () => {
  global.__prismaFindFirst = async () => ({ providerRef: null, monto: { toNumber: () => 2000 } });
  const result = await healOrphanedIntent(BASE_PARAMS);
  assert.ok("healed" in result && result.healed === true, "should be healed: true");
});

// ── invalid amount guard ─────────────────────────────────────────────────────

test("healOrphanedIntent: returns { error: 'invalid_amount' } when monto is NaN", async () => {
  global.__prismaFindFirst = async () => ({ providerRef: null, monto: { toNumber: () => NaN } });
  const result = await healOrphanedIntent(BASE_PARAMS);
  assert.ok("error" in result);
  assert.equal(result.error, "invalid_amount");
});
