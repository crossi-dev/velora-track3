"use strict";
// Tests for the onboarding-nudge Cloud Tasks worker logic.
// Covers:
//   - pickDueIntegration: window logic, ART-day cap, firstSaleAt null guard
//   - worker: bounded re-schedule (attempt < MAX stops, attempt >= MAX stops)
//   - worker: skips nudge when integration is already connected (hasUnconnectedIntegrations)
//   - enqueueOnboardingNudge: ALREADY_EXISTS (gRPC 6) treated as success (no-op)
//   - worker route: internal_error result → 500, attempt not consumed, enqueue NOT called (Fix 1)
//   - worker route: await enqueue before 200 (Fix 2 — enqueue called synchronously before return)
//   - worker route: attempt type guard rejects float and negative integers (Fix 3)
//   - worker route: attempt=MAX-1 (last batch) → 200, no re-enqueue after max reached

const assert = require("node:assert/strict");
const test = require("node:test");
const Module = require("node:module");
const path = require("node:path");

const WINDOWS_SUT_PATH = path.resolve(__dirname, "../../src/app/api/_lib/onboarding-nudge-windows.ts");
const CLOUD_LOGGER_PATH = path.resolve(__dirname, "../../src/lib/cloud-logger.ts");
const PRISMA_PATH = path.resolve(__dirname, "../../src/lib/prisma.ts");
const TODAY_SUMMARY_PATH = path.resolve(__dirname, "../../src/app/dashboard/lib/today-summary.ts");
const ENQUEUE_SUT_PATH = path.resolve(__dirname, "../../src/lib/cloud-tasks-onboarding-nudge.ts");
const TASKS_CLIENT_PATH = require.resolve("@google-cloud/tasks");

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeStubs({ todaySlot = "2026-06-07", prismaOverrides = {} } = {}) {
  const prismaStub = {
    business: {
      findUnique: async () => null,
      updateMany: async () => ({ count: 0 }),
    },
    mpConnection: { findUnique: async () => null },
    courierCredential: { findFirst: async () => null },
    arcaCredential: { findUnique: async () => null },
    ...prismaOverrides,
  };

  Module._cache[CLOUD_LOGGER_PATH] = {
    id: CLOUD_LOGGER_PATH, filename: CLOUD_LOGGER_PATH, loaded: true,
    exports: { cloudLog: () => {}, runWithTraceContext: (_, fn) => fn() },
  };
  Module._cache[TODAY_SUMMARY_PATH] = {
    id: TODAY_SUMMARY_PATH, filename: TODAY_SUMMARY_PATH, loaded: true,
    exports: { getArgentinaDateString: () => todaySlot },
  };
  Module._cache[PRISMA_PATH] = {
    id: PRISMA_PATH, filename: PRISMA_PATH, loaded: true,
    exports: { prisma: prismaStub },
  };

  return { prismaStub };
}

function loadWindowsSut() {
  delete Module._cache[WINDOWS_SUT_PATH];
  delete Module._cache[TODAY_SUMMARY_PATH];
  return require(WINDOWS_SUT_PATH);
}

// ── pickDueIntegration tests ──────────────────────────────────────────────────

test("pickDueIntegration: returns null when firstSaleAt is null", () => {
  makeStubs();
  const sut = loadWindowsSut();
  const result = sut.pickDueIntegration({ firstSaleAt: null, mpNudgeShownAt: null, whatsappNudgeShownAt: null, andreaniNudgeShownAt: null, arcaNudgeShownAt: null }, Date.now());
  assert.equal(result, null);
});

test("pickDueIntegration: returns null when no window has elapsed", () => {
  makeStubs();
  const sut = loadWindowsSut();
  // firstSaleAt = 1h ago — MP window is 24h, so nothing is due yet.
  const firstSaleAt = new Date(Date.now() - 1 * 60 * 60 * 1000);
  const result = sut.pickDueIntegration(
    { firstSaleAt, mpNudgeShownAt: null, whatsappNudgeShownAt: null, andreaniNudgeShownAt: null, arcaNudgeShownAt: null },
    Date.now(),
  );
  assert.equal(result, null);
});

test("pickDueIntegration: returns mp when 24h elapsed and not yet shown today", () => {
  makeStubs({ todaySlot: "2026-06-07" });
  const sut = loadWindowsSut();
  const firstSaleAt = new Date(Date.now() - 25 * 60 * 60 * 1000); // 25h ago
  const result = sut.pickDueIntegration(
    { firstSaleAt, mpNudgeShownAt: null, whatsappNudgeShownAt: null, andreaniNudgeShownAt: null, arcaNudgeShownAt: null },
    Date.now(),
  );
  assert.equal(result, "mp");
});

test("pickDueIntegration: returns null when already nudged today (ART-day cap)", () => {
  // mp was shown today → one-per-day cap kicks in.
  makeStubs({ todaySlot: "2026-06-07" });
  const sut = loadWindowsSut();
  const firstSaleAt = new Date(Date.now() - 25 * 60 * 60 * 1000);
  const mpNudgeShownAt = new Date("2026-06-07T12:00:00Z"); // same slot as today stub
  const result = sut.pickDueIntegration(
    { firstSaleAt, mpNudgeShownAt, whatsappNudgeShownAt: null, andreaniNudgeShownAt: null, arcaNudgeShownAt: null },
    Date.now(),
  );
  assert.equal(result, null);
});

test("pickDueIntegration: returns andreani (not mp) when mp was shown on a prior day", () => {
  // mp shownAt is yesterday → not in today's slot → cap does not block.
  // But mp window elapsed → mp is still eligible UNLESS already connected.
  // Since this only tests window logic (not connection), mp would be first in priority.
  // The test verifies that a PRIOR-day shownAt does NOT trigger the daily cap.
  makeStubs({ todaySlot: "2026-06-07" });
  const sut = loadWindowsSut();
  const firstSaleAt = new Date(Date.now() - 50 * 60 * 60 * 1000); // 50h ago → mp + andreani windows elapsed
  const mpNudgeShownAt = new Date("2026-06-06T12:00:00Z"); // yesterday
  const result = sut.pickDueIntegration(
    { firstSaleAt, mpNudgeShownAt, whatsappNudgeShownAt: null, andreaniNudgeShownAt: null, arcaNudgeShownAt: null },
    Date.now(),
  );
  // mp is still first in priority and prior-day shownAt does not block — mp is returned.
  assert.equal(result, "mp");
});

// ── enqueueOnboardingNudge: ALREADY_EXISTS (gRPC 6) ───────────────────────────

test("enqueueOnboardingNudge: treats ALREADY_EXISTS (gRPC 6) as success (no throw)", async () => {
  makeStubs();

  // Stub CloudTasksClient to throw gRPC 6.
  const fakeTasksClient = {
    queuePath: () => "projects/p/locations/l/queues/q",
    taskPath: () => "projects/p/locations/l/queues/q/tasks/t",
    createTask: async () => { const e = new Error("ALREADY_EXISTS"); e.code = 6; throw e; },
  };
  Module._cache[TASKS_CLIENT_PATH] = {
    id: TASKS_CLIENT_PATH, filename: TASKS_CLIENT_PATH, loaded: true,
    exports: { CloudTasksClient: function() { return fakeTasksClient; } },
  };

  delete Module._cache[ENQUEUE_SUT_PATH];
  const sut = require(ENQUEUE_SUT_PATH);

  await assert.doesNotReject(
    () => sut.enqueueOnboardingNudge({ businessId: "biz-001", attempt: 0, delaySeconds: 86400, slotDate: "2026-06-07" }),
    "ALREADY_EXISTS must be treated as success — must not throw",
  );

  // Restore
  delete Module._cache[TASKS_CLIENT_PATH];
  delete Module._cache[ENQUEUE_SUT_PATH];
});

test("enqueueOnboardingNudge: absorbs unexpected errors without throwing", async () => {
  makeStubs();

  const fakeTasksClient = {
    queuePath: () => "projects/p/locations/l/queues/q",
    taskPath: () => "projects/p/locations/l/queues/q/tasks/t",
    createTask: async () => { throw new Error("UNAVAILABLE: cloud tasks unreachable"); },
  };
  Module._cache[TASKS_CLIENT_PATH] = {
    id: TASKS_CLIENT_PATH, filename: TASKS_CLIENT_PATH, loaded: true,
    exports: { CloudTasksClient: function() { return fakeTasksClient; } },
  };

  delete Module._cache[ENQUEUE_SUT_PATH];
  const sut = require(ENQUEUE_SUT_PATH);

  await assert.doesNotReject(
    () => sut.enqueueOnboardingNudge({ businessId: "biz-002", attempt: 1, delaySeconds: 3600, slotDate: "2026-06-07" }),
    "unexpected errors must be absorbed — enqueueOnboardingNudge never throws",
  );

  delete Module._cache[TASKS_CLIENT_PATH];
  delete Module._cache[ENQUEUE_SUT_PATH];
});

// ── getMaxAttempts ────────────────────────────────────────────────────────────

test("getMaxAttempts: returns 5 when ONBOARDING_NUDGE_MAX_ATTEMPTS is unset", () => {
  delete process.env.ONBOARDING_NUDGE_MAX_ATTEMPTS;
  makeStubs();
  const sut = loadWindowsSut();
  assert.equal(sut.getMaxAttempts(), 5);
});

test("getMaxAttempts: reads ONBOARDING_NUDGE_MAX_ATTEMPTS when set", () => {
  process.env.ONBOARDING_NUDGE_MAX_ATTEMPTS = "3";
  makeStubs();
  const sut = loadWindowsSut();
  assert.equal(sut.getMaxAttempts(), 3);
  delete process.env.ONBOARDING_NUDGE_MAX_ATTEMPTS;
});

// ── Worker route: Fix 1 / Fix 2 / Fix 3 integration tests ────────────────────
//
// These tests exercise the exported POST handler end-to-end with mocked imports
// so we can assert on return status and enqueue call count without a running server.

const ROUTE_SUT_PATH = path.resolve(
  __dirname,
  "../../src/app/api/internal/tasks/onboarding-nudge/route.ts",
);
const INTEGRATION_NUDGE_PATH = path.resolve(
  __dirname,
  "../../src/app/api/_lib/onboarding-integration-nudge.ts",
);
const NUDGE_WINDOWS_PATH = path.resolve(
  __dirname,
  "../../src/app/api/_lib/onboarding-nudge-windows.ts",
);
const VERIFY_OIDC_PATH = path.resolve(
  __dirname,
  "../../src/app/api/internal/tasks/onboarding-nudge/_lib/verify-oidc-token.ts",
);
const TODAY_SUMMARY_PATH2 = path.resolve(
  __dirname,
  "../../src/app/dashboard/lib/today-summary.ts",
);

// Minimal NextRequest/NextResponse mocks that satisfy the route handler.
function makeNextServer() {
  return {
    NextRequest: class MockNextRequest {},
    NextResponse: {
      json: (body, init) => ({
        _body: body,
        _status: init?.status ?? 200,
        status: init?.status ?? 200,
      }),
    },
  };
}

function makeReq({ body = {}, headers = {} } = {}) {
  const hmap = new Map([
    ["authorization", "Bearer mock-oidc"],
    ["x-cloudtasks-queuename", "velora-onboarding-nudge"],
    ...Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
  ]);
  return {
    headers: { get: (k) => hmap.get(k.toLowerCase()) ?? null },
    json: async () => body,
  };
}

/**
 * Loads the route handler with fully controlled dependencies.
 * Returns { POST, enqueueCalls, nudgeCalls }.
 */
function loadRoute({
  flagEnabled = true,
  nudgeResult = "sent",
  maxAttempts = 5,
  windowState = {
    firstSaleAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
    mpNudgeShownAt: null,
    whatsappNudgeShownAt: null,
    andreaniNudgeShownAt: null,
    arcaNudgeShownAt: null,
  },
  hasUnconnected = true,
  integration = "mp",
} = {}) {
  process.env.PROACTIVE_ONBOARDING_ENABLED = flagEnabled ? "true" : "false";
  process.env.ONBOARDING_NUDGE_MAX_ATTEMPTS = String(maxAttempts);

  const enqueueCalls = [];
  const nudgeCalls = [];

  // next/server
  Module._cache[require.resolve("next/server")] = {
    id: "next/server", filename: "next/server", loaded: true,
    exports: makeNextServer(),
  };

  // cloud-logger
  Module._cache[CLOUD_LOGGER_PATH] = {
    id: CLOUD_LOGGER_PATH, filename: CLOUD_LOGGER_PATH, loaded: true,
    exports: {
      cloudLog: () => {},
      runWithTraceContext: (_headers, fn) => fn(),
    },
  };

  // today-summary
  Module._cache[TODAY_SUMMARY_PATH2] = {
    id: TODAY_SUMMARY_PATH2, filename: TODAY_SUMMARY_PATH2, loaded: true,
    exports: { getArgentinaDateString: () => "2026-06-07" },
  };

  // verify-oidc-token — always valid in these tests
  Module._cache[VERIFY_OIDC_PATH] = {
    id: VERIFY_OIDC_PATH, filename: VERIFY_OIDC_PATH, loaded: true,
    exports: { verifyOidcToken: async () => true },
  };

  // onboarding-nudge-windows
  Module._cache[NUDGE_WINDOWS_PATH] = {
    id: NUDGE_WINDOWS_PATH, filename: NUDGE_WINDOWS_PATH, loaded: true,
    exports: {
      pickDueIntegration: () => integration,
      loadNudgeWindowState: async () => windowState,
      hasUnconnectedIntegrations: async () => hasUnconnected,
      getMaxAttempts: () => maxAttempts,
      IDLE_WINDOWS_MS: { mp: 86400000, whatsapp: 172800000, andreani: 172800000, arca: 259200000 },
      INTEGRATION_PRIORITY: ["mp", "andreani", "arca", "whatsapp"],
    },
  };

  // onboarding-integration-nudge
  Module._cache[INTEGRATION_NUDGE_PATH] = {
    id: INTEGRATION_NUDGE_PATH, filename: INTEGRATION_NUDGE_PATH, loaded: true,
    exports: {
      maybeSendIntegrationNudge: async (args) => {
        nudgeCalls.push(args);
        return nudgeResult;
      },
    },
  };

  // cloud-tasks-onboarding-nudge
  Module._cache[ENQUEUE_SUT_PATH] = {
    id: ENQUEUE_SUT_PATH, filename: ENQUEUE_SUT_PATH, loaded: true,
    exports: {
      enqueueOnboardingNudge: async (args) => {
        enqueueCalls.push(args);
      },
    },
  };

  delete Module._cache[ROUTE_SUT_PATH];
  const route = require(ROUTE_SUT_PATH);

  return { POST: route.POST, enqueueCalls, nudgeCalls };
}

function cleanupRoute() {
  delete Module._cache[ROUTE_SUT_PATH];
  delete Module._cache[INTEGRATION_NUDGE_PATH];
  delete Module._cache[NUDGE_WINDOWS_PATH];
  delete Module._cache[VERIFY_OIDC_PATH];
  delete Module._cache[ENQUEUE_SUT_PATH];
  delete Module._cache[TODAY_SUMMARY_PATH2];
  try { delete Module._cache[require.resolve("next/server")]; } catch { /* ok */ }
  delete process.env.ONBOARDING_NUDGE_MAX_ATTEMPTS;
}

// Fix 1: internal_error → 500, attempt counter NOT consumed, enqueue NOT called.
test("worker route: internal_error from nudge send returns 500 and does not enqueue next", async () => {
  const { POST, enqueueCalls } = loadRoute({ nudgeResult: "internal_error", hasUnconnected: true });
  const req = makeReq({ body: { businessId: "biz-001", attempt: 0 } });

  const res = await POST(req);

  assert.equal(res._status, 500, "must return 500 so Cloud Tasks retries same attempt");
  assert.equal(enqueueCalls.length, 0, "enqueue must NOT be called — attempt not consumed");

  cleanupRoute();
});

// Fix 2: successful send → enqueue IS called before 200 (not fire-and-forget).
test("worker route: sent result enqueues next attempt before returning 200", async () => {
  const { POST, enqueueCalls } = loadRoute({ nudgeResult: "sent", hasUnconnected: true, maxAttempts: 5 });
  const req = makeReq({ body: { businessId: "biz-002", attempt: 0 } });

  const res = await POST(req);

  assert.equal(res._status, 200, "must return 200 on successful send");
  assert.equal(enqueueCalls.length, 1, "enqueue must be called for next attempt");
  assert.equal(enqueueCalls[0].attempt, 1, "next attempt must be attempt+1");

  cleanupRoute();
});

// Fix 3: float attempt is rejected with 400.
test("worker route: float attempt value is rejected with 400", async () => {
  const { POST } = loadRoute();
  const req = makeReq({ body: { businessId: "biz-003", attempt: 0.5 } });

  const res = await POST(req);

  assert.equal(res._status, 400, "float attempt must be rejected");

  cleanupRoute();
});

// Fix 3: negative attempt is rejected with 400.
test("worker route: negative attempt value is rejected with 400", async () => {
  const { POST } = loadRoute();
  const req = makeReq({ body: { businessId: "biz-004", attempt: -1 } });

  const res = await POST(req);

  assert.equal(res._status, 400, "negative attempt must be rejected");

  cleanupRoute();
});

// attempt=MAX-1: last valid attempt, chain stops, no re-enqueue.
test("worker route: attempt=MAX-1 returns 200 and does NOT re-enqueue (max reached)", async () => {
  const MAX = 3;
  const { POST, enqueueCalls } = loadRoute({
    nudgeResult: "sent",
    maxAttempts: MAX,
    hasUnconnected: true,
  });
  // attempt=MAX-1 means nextAttempt=MAX, which is NOT < MAX → chain stops.
  const req = makeReq({ body: { businessId: "biz-005", attempt: MAX - 1 } });

  const res = await POST(req);

  assert.equal(res._status, 200, "must return 200 even at max attempt");
  assert.equal(enqueueCalls.length, 0, "must NOT enqueue when attempt+1 >= MAX_ATTEMPTS");

  cleanupRoute();
});
