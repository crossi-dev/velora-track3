// Unit tests — MODO webhook bearer authentication + ACCEPTED path correctness.
//
// The verifyModoBearer helper is private to the route, so we test its
// behaviour through the exported POST handler by simulating NextRequest
// objects with different Authorization headers.
//
// All Prisma, use-case and push calls are mocked — no DB or GCP required.

"use strict";

process.env.AUTH_SECRET =
  process.env.AUTH_SECRET || "test-modo-webhook-bearer-32bytes!!";
process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgresql://test:test@localhost:5432/test";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  clearMockModules,
  resetSourceModules,
  setMockModule,
} = require("../phase4/module-hooks.cjs");

// ── Log capture ────────────────────────────────────────────────────────────────

const logs = [];

function makeLogger() {
  return {
    cloudLog: (entry) => {
      logs.push(entry);
    },
    runWithTraceContext: (_headers, fn) => fn(),
    runWithTraceStore: (_store, fn) => fn(),
    getTraceStore: () => undefined,
    reportError: () => {},
    reportWarning: () => {},
  };
}

// ── Prisma mock ───────────────────────────────────────────────────────────────
// Covers both ACCEPTED (findFirst) and REJECTED/CANCELLED (updateMany) paths.

function makePrismaMock({ findFirstResult = null } = {}) {
  return {
    paymentIntent: {
      updateMany: async () => ({ count: 1 }),
      findFirst: async () => findFirstResult,
    },
    customer: {
      findUnique: async () => null,
    },
  };
}

// ── Use-case mock ─────────────────────────────────────────────────────────────

function makeUseCaseMock({ outcome = "confirmed" } = {}) {
  const calls = [];
  const mock = {
    confirmPaymentIntentUseCase: async (args) => {
      calls.push(args);
      return { outcome };
    },
    _calls: calls,
  };
  return mock;
}

// ── Push mock ──────────────────────────────────────────────────────────────────

function makePushMock() {
  const calls = [];
  const mock = {
    pushOnConfirm: (args) => {
      calls.push(args);
    },
    _calls: calls,
  };
  return mock;
}

// ── NextResponse mock ──────────────────────────────────────────────────────────

function makeNextServerMock() {
  return {
    NextResponse: {
      json: (body, init) => ({
        _body: body,
        _status: init?.status ?? 200,
        json: async () => body,
        status: init?.status ?? 200,
      }),
    },
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeReq(headers = {}, bodyOverride = undefined) {
  const hmap = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const defaultBody = {
    id: "mock-modo-id",
    external_intention_id: "biz123:pi456",
    status: "ACCEPTED",
  };
  return {
    headers: {
      get: (k) => hmap.get(k.toLowerCase()) ?? null,
    },
    json: async () => (bodyOverride !== undefined ? bodyOverride : defaultBody),
  };
}

// ── Load the route with mocks ──────────────────────────────────────────────────

function loadRoute(secret, { findFirstResult, useCaseOutcome } = {}) {
  resetSourceModules();
  clearMockModules();
  logs.length = 0;

  if (secret !== undefined) {
    process.env.MODO_WEBHOOK_SECRET = secret;
  } else {
    delete process.env.MODO_WEBHOOK_SECRET;
  }

  const prismaMock = makePrismaMock({ findFirstResult });
  const useCaseMock = makeUseCaseMock({ outcome: useCaseOutcome ?? "confirmed" });
  const pushMock = makePushMock();

  setMockModule("@/lib/cloud-logger", makeLogger());
  setMockModule("@/lib/prisma", { prisma: prismaMock });
  setMockModule("next/server", makeNextServerMock());
  setMockModule("@/app/api/_lib/route-helpers", {
    checkRateLimit: () => null,        // never rate-limited in tests
    logRouteError: () => {},
  });
  setMockModule("@/app/api/_lib/mutation-contract", {
    getServerActionMeta: () => ({}),
  });
  setMockModule(
    "@/app/api/payment-intents/_lib/payment-intent-use-case",
    useCaseMock,
  );
  setMockModule("../../mp/_lib/webhook-push", pushMock);

  const route = require("../../src/app/api/integrations/modo/webhook/route.ts");
  return { route, prismaMock, useCaseMock, pushMock };
}

// ── Auth tests ─────────────────────────────────────────────────────────────────

test("MODO webhook: missing Authorization header → 401", async () => {
  const { route } = loadRoute("correct-secret");
  const req = makeReq(); // no Authorization header
  const res = await route.POST(req);
  assert.equal(res._status, 401);
  assert.equal(res._body?.error, "unauthorized");
});

test("MODO webhook: wrong Bearer secret → 401 + WARNING log", async () => {
  const { route } = loadRoute("correct-secret");
  const req = makeReq({ Authorization: "Bearer wrong-secret" });
  const res = await route.POST(req);
  assert.equal(res._status, 401);
  const warnLog = logs.find((l) => l.severity === "WARNING" && l.action === "MODO_WEBHOOK_AUTH_FAILED");
  assert.ok(warnLog, "expected WARNING log for failed auth");
});

test("MODO webhook: correct Bearer secret → request proceeds (200 ok)", async () => {
  const { route } = loadRoute("correct-secret", {
    findFirstResult: {
      matchedCustomerId: null,
      createdByEmployeeId: null,
      monto: 1000,
    },
  });
  const req = makeReq({ Authorization: "Bearer correct-secret" });
  const res = await route.POST(req);
  assert.equal(res._status, 200);
  assert.equal(res._body?.ok, true);
});

test("MODO webhook: Authorization without Bearer prefix → 401", async () => {
  const { route } = loadRoute("correct-secret");
  const req = makeReq({ Authorization: "correct-secret" }); // no "Bearer " prefix
  const res = await route.POST(req);
  assert.equal(res._status, 401);
});

test("MODO webhook: MODO_WEBHOOK_SECRET unset → CRITICAL log + 401", async () => {
  const { route } = loadRoute(undefined); // env var absent
  const req = makeReq({ Authorization: "Bearer whatever" });
  const res = await route.POST(req);
  assert.equal(res._status, 401);
  const criticalLog = logs.find(
    (l) => l.severity === "CRITICAL" && l.action === "MODO_WEBHOOK_SECRET_MISSING"
  );
  assert.ok(criticalLog, "expected CRITICAL log when env var is absent");
});

test("MODO webhook: timingSafeEqual is used (source inspection)", () => {
  // The bearer verification logic lives in the _lib helper (refactored for 300-line limit).
  // Check the helper file where verifyModoBearer is implemented.
  const fs = require("node:fs");
  const path = require("node:path");
  const helperSrc = fs.readFileSync(
    path.join(process.cwd(), "src/app/api/integrations/modo/webhook/_lib/modo-webhook-helpers.ts"),
    "utf8"
  );
  assert.ok(
    helperSrc.includes("timingSafeEqual"),
    "modo-webhook-helpers.ts must use timingSafeEqual for constant-time comparison"
  );
  assert.ok(
    helperSrc.includes("from \"node:crypto\"") || helperSrc.includes("from 'node:crypto'"),
    "timingSafeEqual must be imported from node:crypto"
  );
});

// ── ACCEPTED path tests ────────────────────────────────────────────────────────

test("MODO webhook: ACCEPTED → calls confirmPaymentIntentUseCase + pushOnConfirm + returns 200 {ok:true}", async () => {
  const intentRow = {
    matchedCustomerId: null,
    createdByEmployeeId: "emp-1",
    monto: 2500,
  };
  const { route, useCaseMock, pushMock } = loadRoute("correct-secret", {
    findFirstResult: intentRow,
    useCaseOutcome: "confirmed",
  });

  const req = makeReq({ Authorization: "Bearer correct-secret" }, {
    id: "modo-abc",
    external_intention_id: "biz123:pi456",
    status: "ACCEPTED",
  });
  const res = await route.POST(req);

  // Must return 200 with ok:true (not ignored:...)
  assert.equal(res._status, 200);
  assert.equal(res._body?.ok, true);
  assert.equal(res._body?.ignored, undefined, "ACCEPTED path must not set ignored");

  // confirmPaymentIntentUseCase must have been called with correct args
  assert.equal(useCaseMock._calls.length, 1, "use-case must be called once");
  const ucArgs = useCaseMock._calls[0];
  assert.equal(ucArgs.businessId, "biz123");
  assert.equal(ucArgs.paymentIntentId, "pi456");
  assert.equal(ucArgs.actorUserId, "system-modo-webhook");
  assert.equal(ucArgs.idempotencyKey, "modo-webhook-modo-abc");

  // pushOnConfirm must have fired (fire-and-forget)
  assert.equal(pushMock._calls.length, 1, "push must be triggered on confirmed");
  const pushArgs = pushMock._calls[0];
  assert.equal(pushArgs.businessId, "biz123");
  assert.equal(pushArgs.paymentIntentId, "pi456");
  assert.equal(pushArgs.monto, 2500);
});

test("MODO webhook: ACCEPTED with findFirst returning null → 200 ok (no crash, use-case still called)", async () => {
  // intentRow is null — customer fetch skipped, push skipped (no intentRow),
  // but confirmPaymentIntentUseCase must still be invoked.
  const { route, useCaseMock, pushMock } = loadRoute("correct-secret", {
    findFirstResult: null,
    useCaseOutcome: "confirmed",
  });

  const req = makeReq({ Authorization: "Bearer correct-secret" }, {
    id: "modo-xyz",
    external_intention_id: "biz999:pi111",
    status: "ACCEPTED",
  });
  const res = await route.POST(req);

  assert.equal(res._status, 200);
  assert.equal(res._body?.ok, true);
  // use-case must still have been invoked
  assert.equal(useCaseMock._calls.length, 1, "use-case called even without intentRow");
  // push must NOT fire (no intentRow to pass)
  assert.equal(pushMock._calls.length, 0, "push skipped when intentRow is null");
});

test("MODO webhook: REJECTED status → updateMany called, no use-case invoked", async () => {
  const { route, useCaseMock } = loadRoute("correct-secret");
  const req = makeReq({ Authorization: "Bearer correct-secret" }, {
    id: "modo-rej",
    external_intention_id: "biz123:pi456",
    status: "REJECTED",
  });
  const res = await route.POST(req);
  assert.equal(res._status, 200);
  assert.equal(res._body?.ok, true);
  assert.equal(useCaseMock._calls.length, 0, "use-case must NOT be called for REJECTED");
});
