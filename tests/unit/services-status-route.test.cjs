"use strict";
// Tests for /api/services-status route.ts — 8 Prisma queries aggregated into
// a servicios-status response. Owner-only route.
// Strategy: mock resolveActor, requireRole, checkRateLimit, and all Prisma models.

const assert = require("node:assert/strict");
const test = require("node:test");
const Module = require("node:module");
const path = require("node:path");

const { setMockModule, clearMockModules } = (() => {
  try { return require("../phase4/module-hooks.cjs"); }
  catch { return { setMockModule: () => {}, clearMockModules: () => {} }; }
})();

const SUT_PATH = path.resolve(__dirname, "../../src/app/api/services-status/route.ts");
const RESOLVE_ACTOR_PATH = path.resolve(__dirname, "../../src/app/api/_lib/resolve-actor.ts");
const ROUTE_HELPERS_PATH = path.resolve(__dirname, "../../src/app/api/_lib/route-helpers.ts");
const CLOUD_LOGGER_PATH = path.resolve(__dirname, "../../src/lib/cloud-logger.ts");

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeReq() {
  return {
    headers: { get: () => null },
    nextUrl: { pathname: "/api/services-status" },
  };
}

function makeOwnerActor(overrides = {}) {
  return {
    businessId: "biz-test",
    actorUserId: "user-test",
    actorEmployeeId: null,
    role: "owner",
    isTester: false,
    ...overrides,
  };
}

function makeEmployeeActor() {
  return {
    businessId: "biz-test",
    actorUserId: "user-test",
    actorEmployeeId: "emp-001",
    role: "employee",
    isTester: false,
  };
}

// Build the mock for NextResponse.json to return a real-ish response object.
// We need next/server available for the route.
const NEXT_SERVER_PATH = (() => {
  try { return require.resolve("next/server"); } catch { return null; }
})();

function installMocks({ actor, requireRoleResult = null, prismaData = {} }) {
  // Mocked resolveActor returns the actor (or null for unauthenticated).
  const resolveActorMock = {
    resolveActor: async () => actor,
    requireRole: (_actor, _allowed) => requireRoleResult,
    assertRole: () => {},
  };

  // Route-helpers: checkRateLimit returns null (pass), logRouteError is a no-op,
  // bypassIfTester returns false.
  const routeHelpersMock = {
    checkRateLimit: () => null,
    logRouteError: () => {},
    bypassIfTester: () => false,
  };

  // Build Prisma mock from prismaData config.
  const {
    business = null,
    mpConnection = null,
    modoConnection = null,
    arcaCredential = null,
    andreani = null,
    oca = null,
    correo = null,
    employeeCount = 0,
  } = prismaData;

  let courierCallCount = 0;
  const courierResults = [andreani, oca, correo];

  const mockPrisma = {
    business: { findUnique: async () => business },
    mpConnection: { findUnique: async () => mpConnection },
    modoConnection: { findUnique: async () => modoConnection },
    arcaCredential: { findUnique: async () => arcaCredential },
    courierCredential: { findFirst: async () => courierResults[courierCallCount++] ?? null },
    employee: { count: async () => employeeCount },
  };

  setMockModule("@/lib/prisma", { prisma: mockPrisma });
  setMockModule("@/app/api/_lib/resolve-actor", resolveActorMock);
  setMockModule("@/app/api/_lib/route-helpers", routeHelpersMock);
  setMockModule("@/lib/cloud-logger", { cloudLog: () => {} });

  const prismaResolvedPath = require.resolve("@/lib/prisma");
  Module._cache[prismaResolvedPath] = {
    id: prismaResolvedPath, filename: prismaResolvedPath, loaded: true,
    exports: { prisma: mockPrisma },
  };
  Module._cache[RESOLVE_ACTOR_PATH] = {
    id: RESOLVE_ACTOR_PATH, filename: RESOLVE_ACTOR_PATH, loaded: true,
    exports: resolveActorMock,
  };
  Module._cache[ROUTE_HELPERS_PATH] = {
    id: ROUTE_HELPERS_PATH, filename: ROUTE_HELPERS_PATH, loaded: true,
    exports: routeHelpersMock,
  };
  Module._cache[CLOUD_LOGGER_PATH] = {
    id: CLOUD_LOGGER_PATH, filename: CLOUD_LOGGER_PATH, loaded: true,
    exports: { cloudLog: () => {} },
  };
}

function resetSut() {
  delete Module._cache[SUT_PATH];
  delete Module._cache[RESOLVE_ACTOR_PATH];
  delete Module._cache[ROUTE_HELPERS_PATH];
}

function loadSut() {
  return require(SUT_PATH);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test("GET /services-status: unauthenticated → 401", async () => {
  resetSut();
  installMocks({ actor: null });
  const { GET } = loadSut();
  const res = await GET(makeReq());
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.code, "UNAUTHORIZED");
});

test("GET /services-status: employee actor → 403 (requireRole blocks)", async () => {
  resetSut();
  // requireRole returns a 403 NextResponse when role is employee.
  const { NextResponse } = require("next/server");
  const forbidden = NextResponse.json({ code: "FORBIDDEN" }, { status: 403 });
  installMocks({ actor: makeEmployeeActor(), requireRoleResult: forbidden });
  const { GET } = loadSut();
  const res = await GET(makeReq());
  assert.equal(res.status, 403);
});

test("GET /services-status: owner actor → 200 with 5 top-level keys", async () => {
  resetSut();
  installMocks({ actor: makeOwnerActor() });
  const { GET } = loadSut();
  const res = await GET(makeReq());
  assert.equal(res.status, 200);
  const body = await res.json();
  const keys = Object.keys(body);
  assert.ok(keys.includes("supervisor"), "must have supervisor");
  assert.ok(keys.includes("companion"), "must have companion");
  assert.ok(keys.includes("fiscal"), "must have fiscal");
  assert.ok(keys.includes("ventas"), "must have ventas");
  assert.ok(keys.includes("logistica"), "must have logistica");
});

test("GET /services-status: mpConnection=null → mercadopago.connected=false", async () => {
  resetSut();
  installMocks({ actor: makeOwnerActor(), prismaData: { mpConnection: null } });
  const { GET } = loadSut();
  const res = await GET(makeReq());
  const body = await res.json();
  const mp = body.ventas.providers.find((p) => p.id === "mercadopago");
  assert.ok(mp, "mercadopago provider must be present");
  assert.equal(mp.connected, false);
});

test("GET /services-status: mpConnection row present → mercadopago.connected=true", async () => {
  resetSut();
  installMocks({
    actor: makeOwnerActor(),
    prismaData: { mpConnection: { id: "mp-1", businessId: "biz-test", expiresAt: null } },
  });
  const { GET } = loadSut();
  const res = await GET(makeReq());
  const body = await res.json();
  const mp = body.ventas.providers.find((p) => p.id === "mercadopago");
  assert.equal(mp.connected, true);
});

test("GET /services-status: mpConnection.expiresAt forwarded as ISO string", async () => {
  resetSut();
  const expiresAt = new Date("2026-06-01T00:00:00Z");
  installMocks({
    actor: makeOwnerActor(),
    prismaData: { mpConnection: { id: "mp-1", businessId: "biz-test", expiresAt } },
  });
  const { GET } = loadSut();
  const res = await GET(makeReq());
  const body = await res.json();
  const mp = body.ventas.providers.find((p) => p.id === "mercadopago");
  assert.equal(mp.expiresAt, expiresAt.toISOString());
});

test("GET /services-status: business.alias non-empty → alias.connected=true and value forwarded", async () => {
  resetSut();
  installMocks({
    actor: makeOwnerActor(),
    prismaData: { business: { alias: "mitienda.mp" } },
  });
  const { GET } = loadSut();
  const res = await GET(makeReq());
  const body = await res.json();
  const aliasProvider = body.ventas.providers.find((p) => p.id === "alias");
  assert.equal(aliasProvider.connected, true);
  assert.equal(aliasProvider.value, "mitienda.mp");
});

test("GET /services-status: business.alias null → alias.connected=false", async () => {
  resetSut();
  installMocks({
    actor: makeOwnerActor(),
    prismaData: { business: { alias: null } },
  });
  const { GET } = loadSut();
  const res = await GET(makeReq());
  const body = await res.json();
  const aliasProvider = body.ventas.providers.find((p) => p.id === "alias");
  assert.equal(aliasProvider.connected, false);
});

test("GET /services-status: courierCredential rows populate logistica connected flags", async () => {
  resetSut();
  installMocks({
    actor: makeOwnerActor(),
    prismaData: {
      andreani: { id: "a1", provider: "andreani" },
      oca: null,
      correo: { id: "c1", provider: "correo" },
    },
  });
  const { GET } = loadSut();
  const res = await GET(makeReq());
  const body = await res.json();
  const andreani = body.logistica.providers.find((p) => p.id === "andreani");
  const oca = body.logistica.providers.find((p) => p.id === "oca");
  const correo = body.logistica.providers.find((p) => p.id === "correo");
  assert.equal(andreani.connected, true);
  assert.equal(oca.connected, false);
  assert.equal(correo.connected, true);
});

test("GET /services-status: employee.count populates companion.employeeCount", async () => {
  resetSut();
  installMocks({ actor: makeOwnerActor(), prismaData: { employeeCount: 5 } });
  const { GET } = loadSut();
  const res = await GET(makeReq());
  const body = await res.json();
  assert.equal(body.companion.employeeCount, 5);
});

test("GET /services-status: Prisma error in Promise.all → 500 SERVICES_STATUS_FAILED", async () => {
  resetSut();

  // Build a Prisma that throws on business.findUnique to simulate a DB failure.
  const throwingPrisma = {
    business: { findUnique: async () => { throw new Error("DB connection lost"); } },
    mpConnection: { findUnique: async () => null },
    modoConnection: { findUnique: async () => null },
    arcaCredential: { findUnique: async () => null },
    courierCredential: { findFirst: async () => null },
    employee: { count: async () => 0 },
  };

  const resolveActorMock = { resolveActor: async () => makeOwnerActor(), requireRole: () => null, assertRole: () => {} };
  const routeHelpersMock = { checkRateLimit: () => null, logRouteError: () => {}, bypassIfTester: () => false };

  setMockModule("@/lib/prisma", { prisma: throwingPrisma });
  setMockModule("@/app/api/_lib/resolve-actor", resolveActorMock);
  setMockModule("@/app/api/_lib/route-helpers", routeHelpersMock);
  setMockModule("@/lib/cloud-logger", { cloudLog: () => {} });

  const prismaResolvedPath = require.resolve("@/lib/prisma");
  Module._cache[prismaResolvedPath] = {
    id: prismaResolvedPath, filename: prismaResolvedPath, loaded: true,
    exports: { prisma: throwingPrisma },
  };
  Module._cache[RESOLVE_ACTOR_PATH] = {
    id: RESOLVE_ACTOR_PATH, filename: RESOLVE_ACTOR_PATH, loaded: true,
    exports: resolveActorMock,
  };
  Module._cache[ROUTE_HELPERS_PATH] = {
    id: ROUTE_HELPERS_PATH, filename: ROUTE_HELPERS_PATH, loaded: true,
    exports: routeHelpersMock,
  };
  Module._cache[CLOUD_LOGGER_PATH] = {
    id: CLOUD_LOGGER_PATH, filename: CLOUD_LOGGER_PATH, loaded: true,
    exports: { cloudLog: () => {} },
  };

  const { GET } = loadSut();
  const res = await GET(makeReq());
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.equal(body.code, "SERVICES_STATUS_FAILED");
});
