"use strict";
// Unit tests — MODO preflight credential validator.
//
// Tests cover:
//   Part 1: ModoPreflightError class shape
//   Part 2: validateModoCreds — success (no error thrown) via fetchImpl injection
//   Part 3: validateModoCreds — 401 → non-transient error
//   Part 4: validateModoCreds — network throw → transient error
//   Part 5: clientSecret NOT in any thrown error message

const assert = require("node:assert/strict");
const test   = require("node:test");

const {
  clearMockModules,
  resetSourceModules,
  setMockModule,
} = require("../phase4/module-hooks.cjs");

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeFetch(statusCode, body) {
  return async (_url, _init) => ({
    ok: statusCode >= 200 && statusCode < 300,
    status: statusCode,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    json: async () => (typeof body === "string" ? JSON.parse(body) : body),
  });
}

function buildJwt(expOffsetSec = 3600) {
  const exp = Math.floor(Date.now() / 1000) + expOffsetSec;
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ sub: "test", exp })).toString("base64url");
  return `${header}.${payload}.sig`;
}

function loadPreflight() {
  resetSourceModules();
  clearMockModules();
  setMockModule("@/lib/cloud-logger", { cloudLog: () => {} });
  setMockModule("@/lib/prisma", { prisma: { modoConnection: { findUnique: async () => null } } });
  setMockModule("@/infrastructure/crypto/mp-token-cipher", { decrypt: (s) => s, encrypt: (s) => s });
  return require("../../src/app/api/integrations/modo/connect/_lib/modo-preflight.ts");
}

// ── Part 1: ModoPreflightError shape ─────────────────────────────────────────

test("ModoPreflightError — is an Error with spanishMessage and transient fields", () => {
  const { ModoPreflightError } = loadPreflight();

  const err = new ModoPreflightError("Las credenciales son incorrectas.");
  assert.ok(err instanceof Error);
  assert.ok(err instanceof ModoPreflightError);
  assert.equal(err.name, "ModoPreflightError");
  assert.equal(err.spanishMessage, "Las credenciales son incorrectas.");
  assert.equal(err.transient, false);
});

test("ModoPreflightError — transient=true flag preserved", () => {
  const { ModoPreflightError } = loadPreflight();
  const err = new ModoPreflightError("Timeout.", true);
  assert.equal(err.transient, true);
});

// ── Part 2: validateModoCreds — success ───────────────────────────────────────
// We inject a fetchImpl that returns a valid JWT so getModoToken returns a token.

test("validateModoCreds — 200 with valid JWT → resolves without error", async () => {
  const { validateModoCreds } = loadPreflight();
  const jwt = buildJwt();
  const fetchMock = makeFetch(200, jwt); // bare JWT string — not JSON
  const creds = { clientId: "cid", clientSecret: "sec", storeId: "sid" };
  await assert.doesNotReject(async () => validateModoCreds(creds, fetchMock));
});

// ── Part 3: validateModoCreds — 401 → non-transient error ─────────────────────

test("validateModoCreds — 401 from MODO → ModoPreflightError transient=false", async () => {
  const { validateModoCreds, ModoPreflightError } = loadPreflight();
  const fetchMock = makeFetch(401, { error: "Unauthorized" });
  const creds = { clientId: "bad", clientSecret: "wrong", storeId: "sid" };

  await assert.rejects(
    async () => validateModoCreds(creds, fetchMock),
    (err) => {
      assert.ok(err instanceof ModoPreflightError, `expected ModoPreflightError, got ${err?.constructor?.name}`);
      assert.equal(err.transient, false, "expected non-transient (bad credentials)");
      return true;
    },
  );
});

// ── Part 4: network throw → transient error ───────────────────────────────────

test("validateModoCreds — fetch throws (network error) → ModoPreflightError transient=true", async () => {
  const { validateModoCreds, ModoPreflightError } = loadPreflight();
  const fetchMock = async () => { throw new Error("ECONNREFUSED"); };
  const creds = { clientId: "c", clientSecret: "s", storeId: "st" };

  await assert.rejects(
    async () => validateModoCreds(creds, fetchMock),
    (err) => {
      assert.ok(err instanceof ModoPreflightError, `expected ModoPreflightError, got ${err?.constructor?.name}`);
      assert.equal(err.transient, true, "expected transient (network error)");
      return true;
    },
  );
});

// ── Part 5: clientSecret NOT in error message ─────────────────────────────────

test("validateModoCreds — clientSecret not present in thrown error message", async () => {
  const { validateModoCreds, ModoPreflightError } = loadPreflight();
  const secret = "PRIVATE_SECRET_XYZ9999";
  const fetchMock = makeFetch(401, {});
  const creds = { clientId: "cid", clientSecret: secret, storeId: "sid" };

  let caughtErr = null;
  try {
    await validateModoCreds(creds, fetchMock);
  } catch (err) {
    caughtErr = err;
  }

  assert.ok(caughtErr instanceof ModoPreflightError, "expected ModoPreflightError");
  const msg = caughtErr.spanishMessage + " " + caughtErr.message;
  assert.ok(!msg.includes(secret), `clientSecret appeared in error message: ${msg}`);
});
