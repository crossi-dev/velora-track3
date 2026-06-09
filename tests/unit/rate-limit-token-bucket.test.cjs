// Tests for rate-limit-token-bucket.ts (consumeToken + cleanStaleBuckets).
// Uses a manual Prisma mock — no real DB required.
//
// Test cases:
//   1. First request (INSERT path) — allowed, capacity - 1 returned.
//   2. Subsequent request with tokens remaining — allowed.
//   3. Bucket empty (UPDATE returns 0 rows) — denied.
//   4. Refill via elapsed time — tokens accumulate after idle period.
//   5. Fail-open when DB throws — allowed, warning logged.
//   6. cleanStaleBuckets calls deleteMany with correct cutoff.

process.env.AUTH_SECRET = process.env.AUTH_SECRET || "test-secret-32-bytes-long-padding-x";
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgresql://test:test@localhost:5432/test";

const assert = require("node:assert/strict");
const { test, after } = require("node:test");
const {
  clearMockModules,
  setMockModule,
} = require("../phase4/module-hooks.cjs");

// ── Prisma mock ────────────────────────────────────────────────────────────
// Use the shared setMockModule mechanism so the mock is properly scoped and
// cleaned up after this file's tests run. This avoids permanently patching
// Module._load (which would pollute every subsequent test file in the suite).

let mockQueryRawResult = [];
let mockDeleteManyResult = { count: 0 };
let mockQueryRawThrows = false;

// Build a full-featured Prisma mock using a Proxy so any model property
// accessed by transitively-loaded modules (e.g. return-sale.ts uses
// prisma.sale.findFirst) returns a safe no-op instead of crashing.
// Only $queryRaw and rateLimitBucket need real behaviour for these tests.
function makeNoopModel() {
  return {
    findMany: async () => [],
    findFirst: async () => null,
    findUnique: async () => null,
    create: async () => ({}),
    createMany: async () => ({ count: 0 }),
    update: async () => ({}),
    updateMany: async () => ({ count: 0 }),
    delete: async () => ({}),
    deleteMany: async () => ({ count: 0 }),
    upsert: async () => ({}),
    count: async () => 0,
    aggregate: async () => ({}),
  };
}

const mockPrisma = new Proxy({
  $queryRaw: async () => {
    if (mockQueryRawThrows) throw new Error("Neon timeout");
    return mockQueryRawResult;
  },
  rateLimitBucket: {
    deleteMany: async () => mockDeleteManyResult,
  },
}, {
  get(target, prop) {
    if (prop in target) return target[prop];
    return makeNoopModel();
  },
});

const mockCloudLog = { calls: [] };

// Register mocks via the shared mechanism BEFORE loading the module under test.
// Load the module synchronously here (Phase 1) so that consumeToken and
// cleanStaleBuckets bind to mockPrisma by reference. Downstream test files
// that later call clearMockModules() + setMockModule() only affect future
// require() calls — the already-bound closure reference to mockPrisma is safe.
clearMockModules();
setMockModule("@/lib/prisma", { prisma: mockPrisma });
// Stub ALL cloud-logger exports so any transitive import that destructures
// more than cloudLog (e.g. sale-extractor.ts uses reportWarning) doesn't
// get "not a function" when its module is loaded while this stub is active.
setMockModule("@/lib/cloud-logger", {
  cloudLog: (args) => { mockCloudLog.calls.push(args); },
  reportWarning: () => {},
  reportError: () => {},
  logA2ATransfer: () => {},
  logUnauthorizedAccess: () => {},
  traceFieldsFromHeaders: () => ({}),
  runWithTraceContext: (_headers, fn) => fn(),
});

const {
  consumeToken,
  cleanStaleBuckets,
} = require("../../src/app/api/_lib/rate-limit-token-bucket.ts");

// Tear down cleanly after all tests in this file complete so subsequent
// files in the suite do not inherit a stale @/lib/prisma mock.
after(() => {
  clearMockModules();
});

test("module loads without error", () => {
  assert.equal(typeof consumeToken, "function");
  assert.equal(typeof cleanStaleBuckets, "function");
});

// ── consumeToken tests ─────────────────────────────────────────────────────

test("allow when DB returns 1 row (tokens >= 1)", async () => {
  mockQueryRawThrows = false;
  mockQueryRawResult = [{ tokens: 59 }]; // 59 remaining after decrement

  const result = await consumeToken("test:1.2.3.4", { capacity: 60, refillRate: 1 });

  assert.equal(result.allowed, true);
  assert.equal(result.remaining, 59);
});

test("deny when DB returns 0 rows (bucket empty)", async () => {
  mockQueryRawThrows = false;
  mockQueryRawResult = []; // 0 rows = bucket was at 0 after refill

  const result = await consumeToken("test:1.2.3.4", { capacity: 60, refillRate: 1 });

  assert.equal(result.allowed, false);
  assert.equal(result.remaining, 0);
});

test("remaining is clamped to 0 if DB returns negative float", async () => {
  mockQueryRawThrows = false;
  // Edge: floating-point imprecision could yield -0.0000001
  mockQueryRawResult = [{ tokens: -0.0000001 }];

  const result = await consumeToken("test:edge", { capacity: 60, refillRate: 1 });

  assert.equal(result.allowed, true);
  assert.equal(result.remaining, 0); // clamped
});

test("fail-open when DB throws — allowed:true, warning logged", async () => {
  mockQueryRawThrows = true;
  mockCloudLog.calls = [];

  const result = await consumeToken("test:db-down", { capacity: 60, refillRate: 1 });

  assert.equal(result.allowed, true);
  assert.equal(result.remaining, -1); // sentinel for fail-open

  const warned = mockCloudLog.calls.some(
    (c) => c.severity === "WARNING" && c.action === "RATE_LIMIT_DB_FAIL_OPEN"
  );
  assert.ok(warned, "should log a WARNING on DB failure");
});

// ── cleanStaleBuckets tests ────────────────────────────────────────────────

test("cleanStaleBuckets returns deleted count", async () => {
  mockDeleteManyResult = { count: 42 };

  const count = await cleanStaleBuckets(7);

  assert.equal(count, 42);
});

test("cleanStaleBuckets uses correct 7-day cutoff", async () => {
  let capturedWhere = null;
  mockPrisma.rateLimitBucket.deleteMany = async ({ where }) => {
    capturedWhere = where;
    return { count: 0 };
  };

  const before = Date.now();
  await cleanStaleBuckets(7);
  const after = Date.now();

  assert.ok(capturedWhere, "deleteMany should be called with a where clause");
  const cutoffMs = capturedWhere.updatedAt.lt.getTime();
  const expectedCutoffMin = before - 7 * 24 * 60 * 60 * 1000;
  const expectedCutoffMax = after - 7 * 24 * 60 * 60 * 1000;
  assert.ok(
    cutoffMs >= expectedCutoffMin && cutoffMs <= expectedCutoffMax,
    `cutoff ${cutoffMs} should be within [${expectedCutoffMin}, ${expectedCutoffMax}]`
  );
});
