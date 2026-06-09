// Unit tests for sendPushToOwner — fan-out push notification to all active
// subscriptions of a business. G3-3 — Phase 2-7 audit: 68 LOC sin coverage.

const assert = require("node:assert/strict");
const test = require("node:test");
const Module = require("node:module");
const path = require("path");

// ── Module mocks ──────────────────────────────────────────────────────
//
// Node test runner doesn't support jest.mock. We hijack require resolution
// using Module._resolveFilename + Module._cache. Each test resets both maps
// + clears the require cache for the module under test.
//
// IMPORTANT: module-hooks.cjs (loaded by other test files earlier in the suite)
// installs a Module._load interceptor that consults globalState.mocks BEFORE
// Module._cache. To avoid pollution from globalState.mocks left by other files
// (e.g. session-version.test.cjs replaces @/lib/prisma with a user-only mock),
// we also register our mocks via setMockModule / clearMockModules so the
// globalState.mocks path returns this file's own mock.

const { setMockModule, clearMockModules } =
  // module-hooks may already be loaded by a sibling test. Require it fresh so
  // we can call setMockModule without re-installing the hook.
  (() => {
    try {
      return require("../phase4/module-hooks.cjs");
    } catch {
      // Fallback if module-hooks is not available (e.g. isolated run without it)
      return { setMockModule: () => {}, clearMockModules: () => {} };
    }
  })();

const SUT_PATH = path.resolve(__dirname, "../../src/app/api/_lib/owner-push.ts");
const WEB_PUSH_PATH = path.resolve(__dirname, "../../src/app/api/_lib/web-push.ts");

let mockPrisma;
let mockSendPush;

function installMocks() {
  // Inject via globalState.mocks (module-hooks path) so this file's mock wins
  // over any stale globalState.mocks entry left by prior test files.
  setMockModule("@/lib/prisma", { prisma: mockPrisma });
  setMockModule("./web-push", mockSendPush ? { sendPush: mockSendPush } : { sendPush: async () => ({ ok: true }) });

  // Also inject into Module._cache as a belt-and-suspenders fallback for the
  // case where module-hooks is NOT installed (isolated test runs).
  const prismaPath = require.resolve("@/lib/prisma");
  Module._cache[prismaPath] = {
    id: prismaPath, filename: prismaPath, loaded: true,
    exports: { prisma: mockPrisma },
  };
  Module._cache[WEB_PUSH_PATH] = {
    id: WEB_PUSH_PATH, filename: WEB_PUSH_PATH, loaded: true,
    exports: { sendPush: mockSendPush },
  };
}

function resetMocks() {
  // Clear the SUT and its direct dependencies from Module._cache so the next
  // loadSut() call reloads everything fresh against this test's mocks.
  delete Module._cache[SUT_PATH];
  const prismaPath = require.resolve("@/lib/prisma");
  delete Module._cache[prismaPath];
  delete Module._cache[WEB_PUSH_PATH];

  // Also clear transitive deps that owner-push.ts loads at import time:
  // push-resub-prompt.ts and firebase-admin.ts both import @/lib/prisma and
  // will capture a stale reference if cached. Clearing them forces a re-import
  // against the mock installed in the next installMocks() call.
  const pushResubPath = path.resolve(__dirname, "../../src/app/api/_lib/push-resub-prompt.ts");
  delete Module._cache[pushResubPath];
}

function loadSut() {
  return require(SUT_PATH);
}

// ── Tests ─────────────────────────────────────────────────────────────

test("sendPushToOwner: zero subscriptions returns attempted=0", async () => {
  resetMocks();
  mockPrisma = {
    business: { findUnique: async () => ({ userId: "u1" }) },
    pushSubscription: {
      findMany: async () => [],
      update: async () => { throw new Error("should not be called"); },
    },
  };
  mockSendPush = async () => { throw new Error("should not be called"); };
  installMocks();
  const { sendPushToOwner } = loadSut();
  const result = await sendPushToOwner("biz-1", { title: "t", body: "b", url: "/x" });
  assert.deepEqual(result, { attempted: 0, sent: 0, expired: 0, errors: [] });
});

test("sendPushToOwner: all sends OK → sent count matches", async () => {
  resetMocks();
  mockPrisma = {
    business: { findUnique: async () => ({ userId: "u1" }) },
    pushSubscription: {
      findMany: async () => [
        { id: "s1", endpoint: "e1", p256dh: "p1", auth: "a1" },
        { id: "s2", endpoint: "e2", p256dh: "p2", auth: "a2" },
      ],
      update: async () => { throw new Error("should not be called"); },
    },
  };
  mockSendPush = async () => ({ ok: true });
  installMocks();
  const { sendPushToOwner } = loadSut();
  const result = await sendPushToOwner("biz-1", { title: "t", body: "b", url: "/x" });
  assert.equal(result.attempted, 2);
  assert.equal(result.sent, 2);
  assert.equal(result.expired, 0);
});

test("sendPushToOwner: 410 expired marks subscription expired", async () => {
  resetMocks();
  let updateCalled = false;
  mockPrisma = {
    business: { findUnique: async () => ({ userId: "u1" }) },
    pushSubscription: {
      findMany: async () => [{ id: "s1", endpoint: "e1", p256dh: "p1", auth: "a1" }],
      update: async ({ where, data }) => {
        updateCalled = true;
        assert.equal(where.id, "s1");
        assert.equal(data.expired, true);
        return {};
      },
    },
  };
  mockSendPush = async () => ({ ok: false, expired: true, statusCode: 410 });
  installMocks();
  const { sendPushToOwner } = loadSut();
  const result = await sendPushToOwner("biz-1", { title: "t", body: "b", url: "/x" });
  assert.equal(result.expired, 1);
  assert.equal(result.sent, 0);
  assert.equal(updateCalled, true);
});

test("sendPushToOwner: race en update no propaga error", async () => {
  resetMocks();
  mockPrisma = {
    business: { findUnique: async () => ({ userId: "u1" }) },
    pushSubscription: {
      findMany: async () => [{ id: "s1", endpoint: "e1", p256dh: "p1", auth: "a1" }],
      update: async () => { throw new Error("race condition"); },
    },
  };
  mockSendPush = async () => ({ ok: false, expired: true, statusCode: 410 });
  installMocks();
  const { sendPushToOwner } = loadSut();
  const result = await sendPushToOwner("biz-1", { title: "t", body: "b", url: "/x" });
  assert.equal(result.expired, 1, "expired counter increments aún si update falla");
});

test("sendPushToOwner: non-expired error registered en errors[]", async () => {
  resetMocks();
  mockPrisma = {
    business: { findUnique: async () => ({ userId: "u1" }) },
    pushSubscription: {
      findMany: async () => [{ id: "s1", endpoint: "e1", p256dh: "p1", auth: "a1" }],
      update: async () => { throw new Error("should not be called"); },
    },
  };
  mockSendPush = async () => ({ ok: false, expired: false, statusCode: 500, error: "upstream-failure" });
  installMocks();
  const { sendPushToOwner } = loadSut();
  const result = await sendPushToOwner("biz-1", { title: "t", body: "b", url: "/x" });
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0], "upstream-failure");
});

test("sendPushToOwner: mixed results — some OK, some expired, some error", async () => {
  resetMocks();
  let updates = 0;
  mockPrisma = {
    business: { findUnique: async () => ({ userId: "u1" }) },
    pushSubscription: {
      findMany: async () => [
        { id: "s1", endpoint: "e1", p256dh: "p1", auth: "a1" },
        { id: "s2", endpoint: "e2", p256dh: "p2", auth: "a2" },
        { id: "s3", endpoint: "e3", p256dh: "p3", auth: "a3" },
      ],
      update: async () => { updates += 1; return {}; },
    },
  };
  let count = 0;
  mockSendPush = async () => {
    count += 1;
    if (count === 1) return { ok: true };
    if (count === 2) return { ok: false, expired: true, statusCode: 410 };
    return { ok: false, expired: false, statusCode: 500, error: "boom" };
  };
  installMocks();
  const { sendPushToOwner } = loadSut();
  const result = await sendPushToOwner("biz-1", { title: "t", body: "b", url: "/x" });
  assert.equal(result.attempted, 3);
  assert.equal(result.sent, 1);
  assert.equal(result.expired, 1);
  assert.equal(result.errors.length, 1);
  assert.equal(updates, 1);
});

test("sendPushToOwner: only fetches non-expired subscriptions", async () => {
  resetMocks();
  let whereSeen;
  mockPrisma = {
    business: { findUnique: async () => ({ userId: "u1" }) },
    pushSubscription: {
      findMany: async (args) => { whereSeen = args.where; return []; },
      update: async () => ({}),
    },
  };
  mockSendPush = async () => ({ ok: true });
  installMocks();
  const { sendPushToOwner } = loadSut();
  await sendPushToOwner("biz-test", { title: "t", body: "b", url: "/x" });
  assert.equal(whereSeen.businessId, "biz-test");
  assert.equal(whereSeen.expired, false, "filter expired=false en query");
});
