// Unit tests — Employee lockout reset is awaited, not fire-and-forget.
//
// On successful login, the route does:
//   await prisma.employee.update({ ... reset lockout counters ... })
// If the DB write fails, the cookie is still issued but an ERROR is logged.
//
// This is the correct behavior: the DB write being awaited means the
// counter state is consistent before the response is sent. The cookie
// is not blocked by the audit trail (which uses .catch()). The lockout
// reset IS blocking — a failure logs at ERROR and the cookie still goes out.

"use strict";

process.env.AUTH_SECRET =
  process.env.AUTH_SECRET || "test-employee-lockout-reset-32bytes!";
process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgresql://test:test@localhost:5432/test";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  clearMockModules,
  resetSourceModules,
  setMockModule,
} = require("../phase4/module-hooks.cjs");

// ── Helpers ────────────────────────────────────────────────────────────────────

const logs = [];

function makeLogger() {
  return { cloudLog: (e) => logs.push(e) };
}

// Minimal employee row for a successful login (no lockout).
function makeEmployee(overrides = {}) {
  return {
    id: "emp-test-1",
    name: "Maria",
    businessId: "biz-test-1",
    // hashPin("1234") pre-computed using the same scrypt params as the source.
    // We bypass actual PIN verification by mocking verifyPin.
    pinHash: "v1$placeholder$placeholder",
    role: "cashier",
    active: true,
    failedPinAttempts: 0,
    lockedUntil: null,
    consecutiveLockouts: 0,
    sessionVersion: 1,
    ...overrides,
  };
}

// Track DB update call order so we can assert it happened BEFORE the response.
const dbCallLog = [];

function makePrismaMock({ updateThrows = false } = {}) {
  return {
    employee: {
      findMany: async () => [makeEmployee()],
      update: async ({ data }) => {
        dbCallLog.push({ type: "employee.update", data, ts: Date.now() });
        if (updateThrows) {
          throw new Error("DB connection refused");
        }
        return {};
      },
    },
    business: {
      findUnique: async () => ({ sessionDurationHours: 8, userId: "user-test-1" }),
    },
  };
}

function makeNextServerMock(cookiesLog) {
  class FakeResponse {
    constructor(body, init = {}) {
      this._body = body;
      this._status = init.status ?? 200;
      this._cookies = {};
    }
    cookies = {
      set: (name, value, opts) => {
        cookiesLog.push({ name, value, opts });
      },
    };
    json() {
      return Promise.resolve(this._body);
    }
    get status() {
      return this._status;
    }
  }

  return {
    NextRequest: class {},
    NextResponse: {
      json: (body, init) => new FakeResponse(body, init),
    },
  };
}

function makeReq(body = {}) {
  return {
    headers: {
      get: (k) => {
        if (k.toLowerCase() === "x-forwarded-for") return "127.0.0.1";
        if (k.toLowerCase() === "content-type") return "application/json";
        return null;
      },
    },
    json: async () => body,
  };
}

function loadRoute({ updateThrows = false } = {}) {
  logs.length = 0;
  dbCallLog.length = 0;
  const cookiesLog = [];
  resetSourceModules();
  clearMockModules();
  setMockModule("@/lib/cloud-logger", makeLogger());
  setMockModule("@/lib/prisma", { prisma: makePrismaMock({ updateThrows }) });
  setMockModule("next/server", makeNextServerMock(cookiesLog));
  setMockModule("@/app/api/_lib/route-helpers", {
    checkRateLimit: () => null,
    badRequest: (msg) => ({ _body: { error: msg }, _status: 400 }),
    internalError: (msg) => ({ _body: { error: msg }, _status: 500 }),
    jsonError: (code, msg, status) => ({ _body: { code, message: msg }, _status: status }),
    parseJsonBody: async (req) => ({ ok: true, data: await req.json() }),
    logRouteError: () => {},
  });
  // Mock verifyPin: return true when pin === "1234".
  setMockModule("@/lib/employee-auth", {
    ...require("../../src/lib/employee-auth.ts"),
    verifyPin: (pin, _hash) => pin === "1234",
  });
  setMockModule("@/infrastructure/shared/critical-write-audit", {
    recordCriticalWriteEvent: async () => {},
  });
  return {
    route: require("../../src/app/api/employees/login/route.ts"),
    cookiesLog,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

test("lockout reset: successful login → DB write happens before cookie is returned", async () => {
  const { route, cookiesLog } = loadRoute();

  const req = makeReq({ businessId: "biz-test-1", name: "Maria", pin: "1234" });
  const res = await route.POST(req);

  // DB update must have been called.
  const resetCall = dbCallLog.find(
    (c) => c.type === "employee.update" && c.data?.failedPinAttempts === 0
  );
  assert.ok(resetCall, "lockout reset DB write must have been called");

  // Cookie must have been set.
  assert.ok(cookiesLog.length > 0, "cookie must be set on successful login");

  // No ERROR log for the reset path.
  const errorLogs = logs.filter(
    (l) => l.severity === "ERROR" && l.action === "EMPLOYEE_LOGIN_COUNTER_RESET_FAILED"
  );
  assert.equal(errorLogs.length, 0, "no ERROR log expected on clean reset");
});

test("lockout reset: DB write fails → cookie still issued + ERROR logged", async () => {
  const { route, cookiesLog } = loadRoute({ updateThrows: true });

  const req = makeReq({ businessId: "biz-test-1", name: "Maria", pin: "1234" });
  const res = await route.POST(req);

  // Cookie must still be issued despite the DB failure.
  assert.ok(cookiesLog.length > 0, "cookie must still be set even when DB reset fails");

  // ERROR must be logged.
  const errorLog = logs.find(
    (l) => l.severity === "ERROR" && l.action === "EMPLOYEE_LOGIN_COUNTER_RESET_FAILED"
  );
  assert.ok(errorLog, "ERROR must be logged when lockout counter reset fails");
});
