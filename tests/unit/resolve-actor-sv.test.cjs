// Unit tests — resolveActor() sessionVersion (sv) enforcement.
//
// The DB-side sv check lives in resolve-actor.ts: after finding the employee
// row, it compares emp.sessionVersion against empSession.sv and rejects with a
// WARNING log when they diverge. This suite covers that check directly.
//
// All external dependencies (NextAuth, prisma, edge verify) are mocked so no
// real DB or network calls are made.

"use strict";

process.env.AUTH_SECRET =
  process.env.AUTH_SECRET || "test-resolve-actor-sv-secret-32b!";
process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgresql://test:test@localhost:5432/test";
process.env.NODE_ENV = process.env.NODE_ENV || "test";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  clearMockModules,
  setMockModule,
  resetSourceModules,
} = require("../phase4/module-hooks.cjs");

const {
  signEmployeeSession,
} = require("../../src/lib/employee-auth.ts");

// ─── Mock helpers ─────────────────────────────────────────────────────────────

/** Build a minimal NextRequest-like object with a signed employee cookie. */
function makeMockRequest(cookieValue) {
  return {
    cookies: {
      get: (name) => (name === "velora-employee-session" ? { value: cookieValue } : undefined),
    },
    headers: {
      get: () => null,
    },
  };
}

/**
 * Set up all mocks needed by resolve-actor.ts, then require it fresh.
 * Returns { resolveActor, loggedWarnings }.
 */
function setupResolveActor({ dbEmployee }) {
  clearMockModules();
  resetSourceModules();

  // NextAuth auth() — returns null (no OAuth session, so we fall through to employee path)
  setMockModule("@/auth", {
    auth: async () => null,
    ensureBusinessPlaceholder: async () => {},
  });

  // Owner native token — not present
  setMockModule("@/lib/owner-native-auth-edge", {
    OWNER_NATIVE_HEADER: "x-velora-owner-token",
    verifyOwnerNativeToken: async () => null,
  });

  // Prisma mock — employee findUnique returns dbEmployee; business findUnique returns a userId
  setMockModule("@/lib/prisma", {
    prisma: {
      employee: {
        findUnique: async ({ where }) => {
          if (dbEmployee && where.id === dbEmployee.id) return dbEmployee;
          return null;
        },
      },
      business: {
        findUnique: async () => ({ userId: "owner-user-1" }),
      },
    },
  });

  // Cloud logger — capture WARNING calls
  const loggedWarnings = [];
  setMockModule("@/lib/cloud-logger", {
    cloudLog: (entry) => {
      if (entry.severity === "WARNING") loggedWarnings.push(entry);
    },
    logUnauthorizedAccess: () => {},
  });

  // Tester allowlist — always false
  setMockModule("@/lib/tester-allowlist", {
    isTesterEmail: () => false,
  });

  // employee-auth-edge — use real Node employee-auth verifyEmployeeSession
  // (edge variant doesn't work in CJS; we re-export the Node version)
  const { verifyEmployeeSession, EMPLOYEE_COOKIE_NAME } = require("../../src/lib/employee-auth.ts");
  setMockModule("@/lib/employee-auth-edge", {
    EMPLOYEE_COOKIE_NAME,
    verifyEmployeeSession: async (cookie) => {
      const payload = verifyEmployeeSession(cookie);
      if (!payload) return null;
      return { payload };
    },
  });

  const { resolveActor } = require("../../src/app/api/_lib/resolve-actor.ts");
  return { resolveActor, loggedWarnings };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test("resolveActor: valid cookie with matching sv → returns ActorContext", async () => {
  const dbEmployee = {
    id: "emp-sv-1",
    businessId: "biz-1",
    active: true,
    sessionVersion: 3,
  };

  const cookie = signEmployeeSession({
    employeeId: dbEmployee.id,
    businessId: dbEmployee.businessId,
    role: "cashier",
    sv: 3, // matches DB
  });

  const { resolveActor } = setupResolveActor({ dbEmployee });
  const req = makeMockRequest(cookie);
  const ctx = await resolveActor(req);

  assert.ok(ctx !== null, "valid cookie with matching sv must resolve to context");
  assert.equal(ctx.actorEmployeeId, dbEmployee.id);
  assert.equal(ctx.role, "employee");
});

test("resolveActor: stale sv in cookie (post-revocation) → returns null", async () => {
  const dbEmployee = {
    id: "emp-sv-2",
    businessId: "biz-1",
    active: true,
    sessionVersion: 4, // DB bumped after force-logout
  };

  const cookie = signEmployeeSession({
    employeeId: dbEmployee.id,
    businessId: dbEmployee.businessId,
    role: "cashier",
    sv: 3, // stale — issued before revocation
  });

  const { resolveActor, loggedWarnings } = setupResolveActor({ dbEmployee });
  const req = makeMockRequest(cookie);
  const ctx = await resolveActor(req);

  assert.equal(ctx, null, "stale sv must be rejected → null");
  assert.ok(
    loggedWarnings.some((w) => w.action === "EMPLOYEE_SESSION_VERSION_MISMATCH"),
    "EMPLOYEE_SESSION_VERSION_MISMATCH WARNING must be logged",
  );
});

test("resolveActor: sv mismatch log contains cookieSv and dbSv", async () => {
  const dbEmployee = {
    id: "emp-sv-3",
    businessId: "biz-1",
    active: true,
    sessionVersion: 7,
  };

  const cookie = signEmployeeSession({
    employeeId: dbEmployee.id,
    businessId: dbEmployee.businessId,
    role: "cashier",
    sv: 2, // very stale
  });

  const { resolveActor, loggedWarnings } = setupResolveActor({ dbEmployee });
  const req = makeMockRequest(cookie);
  await resolveActor(req);

  const warning = loggedWarnings.find((w) => w.action === "EMPLOYEE_SESSION_VERSION_MISMATCH");
  assert.ok(warning, "warning log entry must exist");
  assert.equal(warning.data.cookieSv, 2, "log must include cookie sv");
  assert.equal(warning.data.dbSv, 7, "log must include DB sv");
  assert.equal(warning.data.employeeId, dbEmployee.id);
});

test("resolveActor: deactivated employee → returns null (independent of sv)", async () => {
  const dbEmployee = {
    id: "emp-sv-4",
    businessId: "biz-1",
    active: false, // deactivated
    sessionVersion: 1,
  };

  const cookie = signEmployeeSession({
    employeeId: dbEmployee.id,
    businessId: dbEmployee.businessId,
    role: "cashier",
    sv: 1,
  });

  const { resolveActor } = setupResolveActor({ dbEmployee });
  const req = makeMockRequest(cookie);
  const ctx = await resolveActor(req);

  assert.equal(ctx, null, "deactivated employee must be rejected regardless of sv");
});

test("resolveActor: employee not found → returns null", async () => {
  const cookie = signEmployeeSession({
    employeeId: "emp-nonexistent",
    businessId: "biz-1",
    role: "cashier",
    sv: 1,
  });

  const { resolveActor } = setupResolveActor({ dbEmployee: null });
  const req = makeMockRequest(cookie);
  const ctx = await resolveActor(req);

  assert.equal(ctx, null, "unknown employee must be rejected");
});
