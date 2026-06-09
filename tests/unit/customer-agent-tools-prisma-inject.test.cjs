// Tests for injectable prisma client in customer-agent-tools.ts factories.
// Design: each factory accepts an optional second `prismaClient` param that
// defaults to the global prisma singleton. These tests verify:
//   1. When prismaClient is injected, the factory uses THAT client (not the global).
//   2. When nothing is passed, behaviour is unchanged (default fallback to global).
//
// Spec reference: core-api-cleanup-p2-customer-facade D2 — minimal prisma seam.
// Approach: inject a spy prisma object and assert the spy was called, proving
// the injected client was used rather than the module-level singleton.

"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const Module = require("node:module");
const path = require("node:path");

const { setMockModule, clearMockModules } = (() => {
  try { return require("../phase4/module-hooks.cjs"); }
  catch { return { setMockModule: () => {}, clearMockModules: () => {} }; }
})();

const SUT_PATH = path.resolve(__dirname, "../../src/lib/adk/customer-agent-tools.ts");
const CLOUD_LOGGER_PATH = path.resolve(__dirname, "../../src/lib/cloud-logger.ts");
const CUSTOMER_MUTATIONS_PATH = path.resolve(
  __dirname,
  "../../src/infrastructure/shared/customer-mutations.ts",
);
const CRITICAL_WRITE_AUDIT_PATH = path.resolve(
  __dirname,
  "../../src/infrastructure/shared/critical-write-audit.ts",
);

function buildGlobalPrisma() {
  return {
    _name: "global",
    customer: { findFirst: async () => null },
    $transaction: async (fn) => {
      return fn({ customer: { findFirst: async () => null, update: async () => ({}) } });
    },
    product: { findMany: async () => [] },
  };
}

function buildInjectedPrismaSpy() {
  const calls = { transaction: 0, findFirst: 0, findMany: 0 };
  const spy = {
    _name: "injected",
    _calls: calls,
    customer: {
      findFirst: async () => {
        calls.findFirst++;
        return { id: "cust-1", phone: "+5492612345678" };
      },
    },
    $transaction: async (fn) => {
      calls.transaction++;
      return fn({
        customer: {
          findFirst: async () => ({ id: "cust-1", name: "TestName" }),
          update: async () => ({ id: "cust-1", name: "TestName" }),
        },
      });
    },
    product: {
      findMany: async () => {
        calls.findMany++;
        return [{ id: "p1", name: "Widget", price: 100, quantity: 5 }];
      },
    },
  };
  return spy;
}

function installBaseMocks(globalPrisma) {
  clearMockModules();

  const mockCloudLog = () => {};
  setMockModule("@/lib/prisma", { prisma: globalPrisma });
  setMockModule("@/lib/cloud-logger", { cloudLog: mockCloudLog });

  const prismaResolvedPath = require.resolve("@/lib/prisma");
  Module._cache[prismaResolvedPath] = {
    id: prismaResolvedPath, filename: prismaResolvedPath, loaded: true,
    exports: { prisma: globalPrisma },
  };
  Module._cache[CLOUD_LOGGER_PATH] = {
    id: CLOUD_LOGGER_PATH, filename: CLOUD_LOGGER_PATH, loaded: true,
    exports: { cloudLog: mockCloudLog },
  };
  Module._cache[CRITICAL_WRITE_AUDIT_PATH] = {
    id: CRITICAL_WRITE_AUDIT_PATH, filename: CRITICAL_WRITE_AUDIT_PATH, loaded: true,
    exports: { recordCriticalWriteEvent: async () => {} },
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
    exports: { Type: { OBJECT: "OBJECT", STRING: "STRING" } },
  };

  Module._cache[CUSTOMER_MUTATIONS_PATH] = {
    id: CUSTOMER_MUTATIONS_PATH, filename: CUSTOMER_MUTATIONS_PATH, loaded: true,
    exports: {
      createCustomerInTransaction: async (_tx, args) => ({
        id: "cust-1", name: args.name || args.phone, phone: args.phone,
        email: null, taxId: null, address: null, postalCode: null, city: null,
      }),
      updateCustomerInTransaction: async (_tx, args) => ({
        id: args.customerId, name: args.name || "Updated",
        phone: null, email: null, taxId: null, address: null, postalCode: null, city: null,
      }),
    },
  };
}

function loadTools() {
  delete Module._cache[SUT_PATH];
  return require(SUT_PATH);
}

function makeCtx(overrides) {
  return Object.assign(
    { businessId: "biz-1", customerPhone: "+5492612345678", appUrl: "http://localhost" },
    overrides || {},
  );
}

// ── RED tests: inject prisma into createLookupOrCreateCustomerTool ─────────────

test("createLookupOrCreateCustomerTool: accepts injected prismaClient and uses it for $transaction", async () => {
  const globalPrisma = buildGlobalPrisma();
  installBaseMocks(globalPrisma);

  const injectedSpy = buildInjectedPrismaSpy();

  const { createLookupOrCreateCustomerTool } = loadTools();

  // Inject the spy as second argument — the factory MUST use it instead of global
  const tool = createLookupOrCreateCustomerTool(makeCtx(), injectedSpy);

  const result = await tool.execute({ name: "TestName" });

  assert.ok(!result.error, "must succeed with injected client (got: " + result.error + ")");
  assert.equal(
    injectedSpy._calls.transaction, 1,
    "injected prisma.$transaction must be called exactly once",
  );
  assert.equal(result.customerId, "cust-1");
});

test("createLookupOrCreateCustomerTool: global prisma is NOT called when injected client is provided", async () => {
  const globalPrisma = buildGlobalPrisma();
  let globalTransactionCalled = false;
  globalPrisma.$transaction = async (fn) => {
    globalTransactionCalled = true;
    return fn({ customer: { findFirst: async () => null } });
  };
  installBaseMocks(globalPrisma);

  const injectedSpy = buildInjectedPrismaSpy();
  const { createLookupOrCreateCustomerTool } = loadTools();
  const tool = createLookupOrCreateCustomerTool(makeCtx(), injectedSpy);
  await tool.execute({ name: "TestName" });

  assert.equal(
    globalTransactionCalled, false,
    "global prisma.$transaction must NOT be called when injected client is provided",
  );
});

// ── RED tests: inject prisma into createUpdateOwnCustomerDataTool ──────────────

test("createUpdateOwnCustomerDataTool: accepts injected prismaClient and uses it for findFirst + $transaction", async () => {
  const globalPrisma = buildGlobalPrisma();
  installBaseMocks(globalPrisma);

  const injectedSpy = buildInjectedPrismaSpy();
  const { createUpdateOwnCustomerDataTool } = loadTools();

  // Inject the spy as second argument
  const tool = createUpdateOwnCustomerDataTool(makeCtx(), injectedSpy);

  const result = await tool.execute({ customerId: "cust-1", name: "New Name" });

  assert.ok(!result.error, "must succeed with injected client (got: " + result.error + ")");
  assert.equal(
    injectedSpy._calls.findFirst, 1,
    "injected prisma.customer.findFirst must be called once (cross-customer guard)",
  );
  assert.equal(
    injectedSpy._calls.transaction, 1,
    "injected prisma.$transaction must be called once (write path)",
  );
});

test("createUpdateOwnCustomerDataTool: global prisma is NOT called when injected client is provided", async () => {
  const globalPrisma = buildGlobalPrisma();
  let globalFindFirstCalled = false;
  let globalTransactionCalled = false;
  globalPrisma.customer.findFirst = async () => {
    globalFindFirstCalled = true;
    return { id: "cust-1", phone: "+5492612345678" };
  };
  globalPrisma.$transaction = async (fn) => {
    globalTransactionCalled = true;
    return fn({ customer: { update: async () => ({ id: "cust-1", name: "x" }) } });
  };
  installBaseMocks(globalPrisma);

  const injectedSpy = buildInjectedPrismaSpy();
  const { createUpdateOwnCustomerDataTool } = loadTools();
  const tool = createUpdateOwnCustomerDataTool(makeCtx(), injectedSpy);
  await tool.execute({ customerId: "cust-1", name: "New Name" });

  assert.equal(
    globalFindFirstCalled, false,
    "global prisma.customer.findFirst must NOT be called when injected client is provided",
  );
  assert.equal(
    globalTransactionCalled, false,
    "global prisma.$transaction must NOT be called when injected client is provided",
  );
});

// ── RED test: inject prisma into createGetCatalogTool ─────────────────────────

test("createGetCatalogTool: accepts injected prismaClient and uses it for product.findMany", async () => {
  const globalPrisma = buildGlobalPrisma();
  installBaseMocks(globalPrisma);

  const injectedSpy = buildInjectedPrismaSpy();
  const { createGetCatalogTool } = loadTools();

  // Inject the spy as second argument
  const tool = createGetCatalogTool(makeCtx(), injectedSpy);
  const result = await tool.execute({});

  assert.ok(!result.error, "must succeed with injected client");
  assert.equal(
    injectedSpy._calls.findMany, 1,
    "injected prisma.product.findMany must be called once",
  );
  assert.ok(Array.isArray(result.products), "must return products array");
  assert.equal(result.products.length, 1, "must return the injected spy's single product");
});

// ── Default fallback: no injection → global used (behaviour preservation) ──────

test("createLookupOrCreateCustomerTool: defaults to global prisma when no injection provided", async () => {
  const globalPrisma = buildGlobalPrisma();
  let globalTransactionCalled = false;
  globalPrisma.$transaction = async (fn) => {
    globalTransactionCalled = true;
    return fn({
      customer: {
        findFirst: async () => null,
        create: async () => ({ id: "cust-new", name: "+5492612345678", phone: "+5492612345678" }),
      },
    });
  };
  installBaseMocks(globalPrisma);

  const { createLookupOrCreateCustomerTool } = loadTools();
  // NO second argument — must use global
  const tool = createLookupOrCreateCustomerTool(makeCtx());
  await tool.execute({ name: "NoInject" });

  assert.equal(
    globalTransactionCalled, true,
    "global prisma.$transaction must be used when no injection provided",
  );
});
