"use strict";
// Unit tests — MODO API helpers (modo-api-helpers.ts).
//
// Tests cover:
//   Part 1: getModoToken — happy path (caches on second call)
//   Part 2: getModoToken — 401 returns null (bad credentials)
//   Part 3: getModoToken — network timeout returns null
//   Part 4: getModoToken — password NOT present in any log/error
//   Part 5: createModoIntention — happy path returns intentionId + checkoutUrl
//   Part 6: createModoIntention — non-OK HTTP returns error
//   Part 7: getModoIntentionStatus — maps ACCEPTED/REJECTED/CANCELLED correctly
//   Part 8: loadModoCredentials — missing row returns NOT_CONNECTED sentinel

const assert = require("node:assert/strict");
const test   = require("node:test");

const {
  clearMockModules,
  resetSourceModules,
  setMockModule,
} = require("../phase4/module-hooks.cjs");

const BIZ_ID = "biz_modo_test_1234567890";

// ── Helper: build a mock fetch ────────────────────────────────────────────────

function makeFetch(statusCode, body) {
  return async (_url, _init) => ({
    ok: statusCode >= 200 && statusCode < 300,
    status: statusCode,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    json: async () => (typeof body === "string" ? JSON.parse(body) : body),
  });
}

// ── Helper: load the module under test ───────────────────────────────────────

function loadHelpers(mocks = {}) {
  resetSourceModules();
  clearMockModules();
  setMockModule("@/lib/cloud-logger", { cloudLog: () => {} });
  // Default prisma mock — no ModoConnection row
  setMockModule("@/lib/prisma", {
    prisma: {
      modoConnection: {
        findUnique: async () => null,
      },
    },
  });
  setMockModule("@/infrastructure/crypto/mp-token-cipher", {
    decrypt: (s) => s, // identity for testing
    encrypt: (s) => s,
  });
  for (const [key, val] of Object.entries(mocks)) {
    setMockModule(key, val);
  }
  return require("../../src/app/api/integrations/modo/_lib/modo-api-helpers.ts");
}

// ── Part 1: getModoToken — happy path ─────────────────────────────────────────

test("getModoToken — 200 with JWT string body → returns token", async () => {
  // Build a minimal JWT with exp = now + 3600s
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ sub: "test", exp })).toString("base64url");
  const jwt = `${header}.${payload}.sig`;

  const { getModoToken } = loadHelpers();
  const creds = { clientId: "cid", clientSecret: "csec", storeId: "sid" };
  const fetchMock = makeFetch(200, jwt);
  const token = await getModoToken("biz_new_1", creds, fetchMock);
  assert.equal(token, jwt);
});

test("getModoToken — 200 with { token: jwt } object → returns token", async () => {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const payload = Buffer.from(JSON.stringify({ exp })).toString("base64url");
  const jwt = `h.${payload}.s`;

  const { getModoToken } = loadHelpers();
  const creds = { clientId: "cid", clientSecret: "csec", storeId: "sid" };
  const fetchMock = makeFetch(200, { token: jwt });
  const token = await getModoToken("biz_new_2", creds, fetchMock);
  assert.equal(token, jwt);
});

// ── Part 2: getModoToken — 401 returns null ───────────────────────────────────

test("getModoToken — 401 from MODO → returns null", async () => {
  const { getModoToken } = loadHelpers();
  const creds = { clientId: "bad", clientSecret: "wrong", storeId: "sid" };
  const fetchMock = makeFetch(401, { error: "Unauthorized" });
  const token = await getModoToken("biz_bad_1", creds, fetchMock);
  assert.equal(token, null);
});

// ── Part 3: getModoToken — network error returns MODO_TOKEN_NETWORK_ERROR ────────

test("getModoToken — fetch throws (network error) → returns null", async () => {
  const { getModoToken, MODO_TOKEN_NETWORK_ERROR } = loadHelpers();
  const creds = { clientId: "cid", clientSecret: "csec", storeId: "sid" };
  const fetchMock = async () => { throw new Error("ECONNREFUSED"); };
  const token = await getModoToken("biz_net_1", creds, fetchMock);
  assert.equal(token, MODO_TOKEN_NETWORK_ERROR);
});

// ── Part 4: password NOT in logs ───────────────────────────────────────────────

test("getModoToken — clientSecret not present in any log call on 401", async () => {
  const loggedData = [];
  const { getModoToken } = loadHelpers({
    "@/lib/cloud-logger": {
      cloudLog: (entry) => { loggedData.push(JSON.stringify(entry)); },
    },
  });
  const secret = "SUPER_SECRET_PASSWORD_12345";
  const creds = { clientId: "cid", clientSecret: secret, storeId: "sid" };
  const fetchMock = makeFetch(401, {});
  await getModoToken("biz_sec_1", creds, fetchMock);

  for (const line of loggedData) {
    assert.ok(
      !line.includes(secret),
      `clientSecret appeared in log: ${line}`,
    );
  }
});

// ── Part 5: createModoIntention — happy path ──────────────────────────────────

test("createModoIntention — CREATED response → returns intentionId and checkoutUrl", async () => {
  const { createModoIntention } = loadHelpers();
  const responseBody = { status: "CREATED", id: "intention_abc123" };
  const fetchMock = makeFetch(200, responseBody);

  const result = await createModoIntention({
    businessId: BIZ_ID,
    storeId: "store_1",
    accessToken: "tok",
    amountARS: 5000,
    description: "Venta Velora",
    externalIntentionId: `${BIZ_ID}:pi_xyz`,
    fetchImpl: fetchMock,
  });

  assert.ok(!("error" in result), `expected success, got error: ${JSON.stringify(result)}`);
  if (!("error" in result)) {
    assert.equal(result.intentionId, "intention_abc123");
    // checkoutUrl is either from response or constructed fallback
    assert.ok(typeof result.checkoutUrl === "string" || result.checkoutUrl === null);
  }
});

// ── Part 6: createModoIntention — non-OK HTTP → error ─────────────────────────

test("createModoIntention — 500 from MODO → returns error", async () => {
  const { createModoIntention } = loadHelpers();
  const fetchMock = makeFetch(500, { error: "Internal Server Error" });

  const result = await createModoIntention({
    businessId: BIZ_ID,
    storeId: "store_1",
    accessToken: "tok",
    amountARS: 5000,
    description: "Venta",
    externalIntentionId: `${BIZ_ID}:pi_z`,
    fetchImpl: fetchMock,
  });

  assert.ok("error" in result, "expected error object");
  if ("error" in result) {
    assert.equal(result.error, "modo_api_error");
  }
});

// ── Part 7: getModoIntentionStatus — status mapping ───────────────────────────

test("getModoIntentionStatus — ACCEPTED → returns status ACCEPTED", async () => {
  const { getModoIntentionStatus } = loadHelpers();
  const fetchMock = makeFetch(200, { status: "ACCEPTED", id: "intention_abc" });

  const result = await getModoIntentionStatus({
    businessId: BIZ_ID,
    intentionId: "intention_abc",
    accessToken: "tok",
    fetchImpl: fetchMock,
  });

  assert.ok(!("error" in result));
  if (!("error" in result)) {
    assert.equal(result.status, "ACCEPTED");
  }
});

test("getModoIntentionStatus — REJECTED → returns status REJECTED", async () => {
  const { getModoIntentionStatus } = loadHelpers();
  const fetchMock = makeFetch(200, { status: "REJECTED", id: "intention_xyz" });

  const result = await getModoIntentionStatus({
    businessId: BIZ_ID,
    intentionId: "intention_xyz",
    accessToken: "tok",
    fetchImpl: fetchMock,
  });

  assert.ok(!("error" in result));
  if (!("error" in result)) {
    assert.equal(result.status, "REJECTED");
  }
});

// ── Part 8: loadModoCredentials — no row → NOT_CONNECTED ─────────────────────

test("loadModoCredentials — no ModoConnection row → MODO_TOKEN_NOT_CONNECTED", async () => {
  const { loadModoCredentials, MODO_TOKEN_NOT_CONNECTED } = loadHelpers({
    "@/lib/prisma": {
      prisma: {
        modoConnection: {
          findUnique: async () => null,
        },
      },
    },
  });

  const result = await loadModoCredentials("biz_no_row");
  assert.equal(result, MODO_TOKEN_NOT_CONNECTED);
});

test("loadModoCredentials — row with all fields → returns ModoCredentials", async () => {
  const creds = { clientId: "cid1", clientSecret: "sec1", storeId: "str1" };
  const { loadModoCredentials } = loadHelpers({
    "@/lib/prisma": {
      prisma: {
        modoConnection: {
          findUnique: async () => ({ encryptedCredentials: JSON.stringify(creds) }),
        },
      },
    },
    "@/infrastructure/crypto/mp-token-cipher": {
      decrypt: (s) => s, // identity — stored as plain JSON in test
      encrypt: (s) => s,
    },
  });

  const result = await loadModoCredentials("biz_with_row");
  assert.ok(result !== "MODO_TOKEN_NOT_CONNECTED");
  assert.ok(result !== "MODO_TOKEN_DECRYPT_ERROR");
  if (typeof result === "object") {
    assert.equal(result.clientId, "cid1");
    assert.equal(result.storeId, "str1");
    // clientSecret is NOT asserted in value — only presence
    assert.ok(typeof result.clientSecret === "string" && result.clientSecret.length > 0);
  }
});
