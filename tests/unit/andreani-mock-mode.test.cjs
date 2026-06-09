// Unit tests — isAndreaniMockMode / isMockEnabled
//
// Covers the canonical env-var check in andreani-mock.ts.
// Rule: MOCK when ANDREANI_MOCK_MODE=true (case-insensitive).
//       REAL (false) when var is absent or any other value.
//       FAIL-CLOSED: throws when NODE_ENV=production AND ANDREANI_MOCK_MODE=true.
//
// Strategy: manipulate process.env directly and reload the module
// via Module._cache flush for each case.

"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");
const Module = require("node:module");

const MODULE_PATH = path.resolve(
  __dirname,
  "../../src/app/api/agents/andreani/_lib/andreani-mock.ts",
);

// Prisma is imported at module-level in andreani-mock.ts — stub it so the
// test does not need a real DB connection. The tests here only exercise the
// pure env-var check; no DB path is hit.
const prismaStubPath = require.resolve("@/lib/prisma");
const demoBizStubPath = require.resolve("@/lib/demo-business");

function installPrismaStub() {
  Module._cache[prismaStubPath] = {
    id: prismaStubPath,
    filename: prismaStubPath,
    loaded: true,
    exports: { prisma: {} },
  };
}

// Install a stub for demo-business with configurable isDemoBusiness behavior.
function installDemoBizStub(isDemoFn) {
  Module._cache[demoBizStubPath] = {
    id: demoBizStubPath,
    filename: demoBizStubPath,
    loaded: true,
    exports: { isDemoBusiness: isDemoFn },
  };
}

function loadMockModule() {
  delete Module._cache[MODULE_PATH];
  installPrismaStub();
  // Default stub: no business is a demo business.
  installDemoBizStub(() => false);
  return require(MODULE_PATH);
}

function loadMockModuleWithDemo(demoBizId) {
  delete Module._cache[MODULE_PATH];
  installPrismaStub();
  installDemoBizStub((id) => id === demoBizId);
  return require(MODULE_PATH);
}

// Save and restore env around each test (both ANDREANI_MOCK_MODE and NODE_ENV).
let savedMockMode;
let savedNodeEnv;
function saveEnv() {
  savedMockMode = process.env.ANDREANI_MOCK_MODE;
  savedNodeEnv = process.env.NODE_ENV;
}
function restoreEnv() {
  if (savedMockMode === undefined) {
    delete process.env.ANDREANI_MOCK_MODE;
  } else {
    process.env.ANDREANI_MOCK_MODE = savedMockMode;
  }
  if (savedNodeEnv === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = savedNodeEnv;
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test("isAndreaniMockMode: var absent → false (real mode, production default)", () => {
  saveEnv();
  delete process.env.ANDREANI_MOCK_MODE;
  const { isAndreaniMockMode } = loadMockModule();
  assert.strictEqual(isAndreaniMockMode(), false);
  restoreEnv();
});

test("isAndreaniMockMode: ANDREANI_MOCK_MODE=true (non-prod) → true", () => {
  saveEnv();
  process.env.ANDREANI_MOCK_MODE = "true";
  delete process.env.NODE_ENV; // ensure non-production
  const { isAndreaniMockMode } = loadMockModule();
  assert.strictEqual(isAndreaniMockMode(), true);
  restoreEnv();
});

test("isAndreaniMockMode: ANDREANI_MOCK_MODE=TRUE uppercase (non-prod) → true", () => {
  saveEnv();
  process.env.ANDREANI_MOCK_MODE = "TRUE";
  delete process.env.NODE_ENV;
  const { isAndreaniMockMode } = loadMockModule();
  assert.strictEqual(isAndreaniMockMode(), true);
  restoreEnv();
});

test("isAndreaniMockMode: ANDREANI_MOCK_MODE=True mixed case (non-prod) → true", () => {
  saveEnv();
  process.env.ANDREANI_MOCK_MODE = "True";
  delete process.env.NODE_ENV;
  const { isAndreaniMockMode } = loadMockModule();
  assert.strictEqual(isAndreaniMockMode(), true);
  restoreEnv();
});

test("isAndreaniMockMode: ANDREANI_MOCK_MODE=false → false (real mode)", () => {
  saveEnv();
  process.env.ANDREANI_MOCK_MODE = "false";
  const { isAndreaniMockMode } = loadMockModule();
  assert.strictEqual(isAndreaniMockMode(), false);
  restoreEnv();
});

test("isAndreaniMockMode: ANDREANI_MOCK_MODE=1 (non-bool truthy string) → false", () => {
  saveEnv();
  process.env.ANDREANI_MOCK_MODE = "1";
  const { isAndreaniMockMode } = loadMockModule();
  assert.strictEqual(isAndreaniMockMode(), false);
  restoreEnv();
});

test("isAndreaniMockMode: ANDREANI_MOCK_MODE='' (empty string) → false", () => {
  saveEnv();
  process.env.ANDREANI_MOCK_MODE = "";
  const { isAndreaniMockMode } = loadMockModule();
  assert.strictEqual(isAndreaniMockMode(), false);
  restoreEnv();
});

test("isMockEnabled is the same function as isAndreaniMockMode (alias check)", () => {
  saveEnv();
  process.env.ANDREANI_MOCK_MODE = "true";
  delete process.env.NODE_ENV;
  const { isMockEnabled, isAndreaniMockMode } = loadMockModule();
  assert.strictEqual(isMockEnabled, isAndreaniMockMode);
  restoreEnv();
});

// ── Fail-closed: production + mock enabled → throw ────────────────────────────

test("isMockEnabled: NODE_ENV=production + ANDREANI_MOCK_MODE=true → throws (fail-closed)", () => {
  saveEnv();
  process.env.ANDREANI_MOCK_MODE = "true";
  process.env.NODE_ENV = "production";
  const { isMockEnabled } = loadMockModule();
  assert.throws(
    () => isMockEnabled(),
    (err) => {
      assert.ok(err instanceof Error, "must be an Error");
      assert.ok(
        err.message.includes("ANDREANI_MOCK_MODE=true is not allowed in production"),
        `unexpected message: ${err.message}`,
      );
      return true;
    },
  );
  restoreEnv();
});

test("isMockEnabled: NODE_ENV=production + ANDREANI_MOCK_MODE=TRUE uppercase → throws", () => {
  saveEnv();
  process.env.ANDREANI_MOCK_MODE = "TRUE";
  process.env.NODE_ENV = "production";
  const { isMockEnabled } = loadMockModule();
  assert.throws(() => isMockEnabled(), Error);
  restoreEnv();
});

test("isMockEnabled: NODE_ENV=production + ANDREANI_MOCK_MODE=false → false (safe, no throw)", () => {
  saveEnv();
  process.env.ANDREANI_MOCK_MODE = "false";
  process.env.NODE_ENV = "production";
  const { isMockEnabled } = loadMockModule();
  assert.strictEqual(isMockEnabled(), false);
  restoreEnv();
});

test("isMockEnabled: NODE_ENV=production + ANDREANI_MOCK_MODE absent → false (safe, no throw)", () => {
  saveEnv();
  delete process.env.ANDREANI_MOCK_MODE;
  process.env.NODE_ENV = "production";
  const { isMockEnabled } = loadMockModule();
  assert.strictEqual(isMockEnabled(), false);
  restoreEnv();
});

// ── Per-business gate: isAndreaniMockActive ───────────────────────────────────

test("isAndreaniMockActive: no businessId + MOCK=true (non-prod) → true (global flag)", () => {
  saveEnv();
  process.env.ANDREANI_MOCK_MODE = "true";
  delete process.env.NODE_ENV;
  const { isAndreaniMockActive } = loadMockModule();
  assert.strictEqual(isAndreaniMockActive(), true);
  restoreEnv();
});

test("isAndreaniMockActive: demo businessId + MOCK=true (non-prod) → true", () => {
  saveEnv();
  process.env.ANDREANI_MOCK_MODE = "true";
  delete process.env.NODE_ENV;
  const DEMO_ID = "demobiz000000000000000001";
  const { isAndreaniMockActive } = loadMockModuleWithDemo(DEMO_ID);
  assert.strictEqual(isAndreaniMockActive(DEMO_ID), true);
  restoreEnv();
});

test("isAndreaniMockActive: non-demo businessId + MOCK=true (non-prod) → false (real mode)", () => {
  saveEnv();
  process.env.ANDREANI_MOCK_MODE = "true";
  delete process.env.NODE_ENV;
  const DEMO_ID = "demobiz000000000000000001";
  const REAL_ID = "realbiz000000000000000001";
  const { isAndreaniMockActive } = loadMockModuleWithDemo(DEMO_ID);
  assert.strictEqual(isAndreaniMockActive(REAL_ID), false);
  restoreEnv();
});

test("isAndreaniMockActive: MOCK=false → false regardless of businessId", () => {
  saveEnv();
  process.env.ANDREANI_MOCK_MODE = "false";
  delete process.env.NODE_ENV;
  const DEMO_ID = "demobiz000000000000000001";
  const { isAndreaniMockActive } = loadMockModuleWithDemo(DEMO_ID);
  assert.strictEqual(isAndreaniMockActive(DEMO_ID), false);
  assert.strictEqual(isAndreaniMockActive(), false);
  restoreEnv();
});
