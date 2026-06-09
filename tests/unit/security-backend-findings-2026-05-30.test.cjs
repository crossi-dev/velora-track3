// Security backend findings — 2026-05-30
//
// Tests for three targeted fixes from overnight audit:
//   M1 — cron OIDC fail-closed when CLOUD_SCHEDULER_SA_EMAIL unset
//   M2 — tester bypass does NOT skip AI/LLM rate limits
//   M3 — Andreani event dedup uses DB transaction (structural check)

"use strict";

process.env.AUTH_SECRET = process.env.AUTH_SECRET || "test-security-findings-secret-32b!";
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgresql://test:test@localhost:5432/test";

const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");
const Module = require("node:module");
const fs = require("node:fs");

// ── stub helpers ───────────────────────────────────────────────────────────

const CRON_AUTH_PATH = path.resolve(__dirname, "../../src/app/api/_lib/cron-auth.ts");
const AI_RATE_LIMIT_PATH = path.resolve(__dirname, "../../src/app/api/_lib/ai-rate-limit.ts");

// cloud-logger stub
const CLOUD_LOGGER_PATH = require.resolve("@/lib/cloud-logger");
function stubCloudLogger() {
  Module._cache[CLOUD_LOGGER_PATH] = {
    id: CLOUD_LOGGER_PATH,
    filename: CLOUD_LOGGER_PATH,
    loaded: true,
    exports: { cloudLog: () => {}, runWithTraceContext: (_, fn) => fn() },
  };
}

// prisma stub
const PRISMA_PATH = require.resolve("@/lib/prisma");
function stubPrisma(updateManyResult = { count: 1 }) {
  Module._cache[PRISMA_PATH] = {
    id: PRISMA_PATH,
    filename: PRISMA_PATH,
    loaded: true,
    exports: {
      prisma: {
        aiRateLimit: {
          updateMany: async () => updateManyResult,
          create: async () => ({}),
        },
      },
    },
  };
}

// rate-limit-token-bucket stub
const BUCKET_PATH = path.resolve(__dirname, "../../src/app/api/_lib/rate-limit-token-bucket.ts");
function stubBucket(allowed = true) {
  Module._cache[BUCKET_PATH] = {
    id: BUCKET_PATH,
    filename: BUCKET_PATH,
    loaded: true,
    exports: { consumeToken: async () => ({ allowed }) },
  };
}

function reloadAiRateLimit() {
  delete Module._cache[AI_RATE_LIMIT_PATH];
  stubCloudLogger();
  stubPrisma();
  stubBucket();
  return require(AI_RATE_LIMIT_PATH);
}

function reloadCronAuth() {
  delete Module._cache[CRON_AUTH_PATH];
  stubCloudLogger();
  return require(CRON_AUTH_PATH);
}

function mockNextReq(authHeader = "") {
  return {
    headers: { get: (k) => (k.toLowerCase() === "authorization" ? authHeader : null) },
  };
}

// ── M2 — AI rate limits never bypassed ────────────────────────────────────

test("checkAiPerMinuteLimit: no bypass param — returns true when rate limit disabled", async () => {
  const { checkAiPerMinuteLimit } = reloadAiRateLimit();
  process.env.RATE_LIMIT_ENABLED = "false";
  const result = await checkAiPerMinuteLimit("user-123");
  assert.equal(result, true);
  delete process.env.RATE_LIMIT_ENABLED;
});

test("checkAiRateLimit: no bypass param — returns true when rate limit disabled", async () => {
  const { checkAiRateLimit } = reloadAiRateLimit();
  process.env.RATE_LIMIT_ENABLED = "false";
  const result = await checkAiRateLimit("user-456");
  assert.equal(result, true);
  delete process.env.RATE_LIMIT_ENABLED;
});

test("checkAiPerMinuteLimit: enforces limit — token bucket denial cannot be bypassed", async () => {
  // Stub bucket as denied BEFORE reloading the module so the dynamic import picks it up
  stubBucket(false);
  delete Module._cache[AI_RATE_LIMIT_PATH]; // force fresh require with new bucket stub
  stubCloudLogger();
  stubPrisma();
  process.env.RATE_LIMIT_ENABLED = "true";
  const { checkAiPerMinuteLimit } = require(AI_RATE_LIMIT_PATH);
  const result = await checkAiPerMinuteLimit("user-789");
  assert.equal(result, false, "token bucket denial must be respected");
  delete process.env.RATE_LIMIT_ENABLED;
});

test("checkAiRateLimit: enforces daily limit (updateMany=0, create=P2002, retry=0)", async () => {
  // Simulate: at limit (updateMany=0) + P2002 on create → P2002 retry also 0
  Module._cache[PRISMA_PATH] = {
    id: PRISMA_PATH,
    filename: PRISMA_PATH,
    loaded: true,
    exports: {
      prisma: {
        aiRateLimit: {
          updateMany: async () => ({ count: 0 }),
          create: async () => { throw Object.assign(new Error("unique"), { code: "P2002" }); },
        },
      },
    },
  };
  delete Module._cache[AI_RATE_LIMIT_PATH];
  stubCloudLogger();
  stubBucket();
  process.env.RATE_LIMIT_ENABLED = "true";
  const { checkAiRateLimit } = require(AI_RATE_LIMIT_PATH);
  const result = await checkAiRateLimit("user-over-limit");
  assert.equal(result, false, "daily limit must be enforced");
  delete process.env.RATE_LIMIT_ENABLED;
});

test("ai-rate-limit source: checkAiPerMinuteLimit has no bypass param in signature", () => {
  const src = fs.readFileSync(AI_RATE_LIMIT_PATH, "utf8");
  // The function signature must not include 'bypass'
  const fnMatch = src.match(/export async function checkAiPerMinuteLimit\([^)]*\)/);
  assert.ok(fnMatch, "checkAiPerMinuteLimit must be exported");
  assert.ok(!fnMatch[0].includes("bypass"), "checkAiPerMinuteLimit must not have bypass parameter");
});

test("ai-rate-limit source: checkAiRateLimit has no bypass param in signature", () => {
  const src = fs.readFileSync(AI_RATE_LIMIT_PATH, "utf8");
  const fnMatch = src.match(/export async function checkAiRateLimit\([^)]*\)/);
  assert.ok(fnMatch, "checkAiRateLimit must be exported");
  assert.ok(!fnMatch[0].includes("bypass"), "checkAiRateLimit must not have bypass parameter");
});

// ── M1 — OIDC fail-closed when SA email unset ─────────────────────────────

test("cron OIDC: fails when CLOUD_SCHEDULER_SA_EMAIL unset — falls through to bearer", async () => {
  // Stub google-auth-library to return a valid Google payload
  let googleAuthPath;
  try {
    googleAuthPath = require.resolve("google-auth-library");
    Module._cache[googleAuthPath] = {
      id: googleAuthPath,
      filename: googleAuthPath,
      loaded: true,
      exports: {
        OAuth2Client: class {
          async verifyIdToken() {
            return {
              getPayload: () => ({
                iss: "https://accounts.google.com",
                email: "any-sa@project.iam.gserviceaccount.com",
                aud: "https://somosvelora.com",
              }),
            };
          }
        },
      },
    };
  } catch {
    // google-auth-library not available in test env — skip
    return;
  }

  const saved = {
    SA: process.env.CLOUD_SCHEDULER_SA_EMAIL,
    SECRET: process.env.CRON_SECRET,
    NEXTAUTH: process.env.NEXTAUTH_URL,
  };

  delete process.env.CLOUD_SCHEDULER_SA_EMAIL;
  delete process.env.CRON_SECRET;
  process.env.NEXTAUTH_URL = "https://somosvelora.com";

  const { verifyCronAuth } = reloadCronAuth();
  const fakeJwt = "header.payload.signature";
  const req = mockNextReq(`Bearer ${fakeJwt}`);
  const result = await verifyCronAuth(req, "test-scope");

  // Restore env
  if (saved.SA !== undefined) process.env.CLOUD_SCHEDULER_SA_EMAIL = saved.SA;
  if (saved.SECRET !== undefined) process.env.CRON_SECRET = saved.SECRET;
  if (saved.NEXTAUTH !== undefined) process.env.NEXTAUTH_URL = saved.NEXTAUTH;
  else delete process.env.NEXTAUTH_URL;

  assert.ok(result !== null, "OIDC must fail-closed when SA email unset — 401 expected");
  assert.equal(result.status, 401);
});

test("cron bearer path: CRON_SECRET works regardless of CLOUD_SCHEDULER_SA_EMAIL", async () => {
  const savedSA = process.env.CLOUD_SCHEDULER_SA_EMAIL;
  const savedSecret = process.env.CRON_SECRET;
  const savedNextauth = process.env.NEXTAUTH_URL;

  delete process.env.CLOUD_SCHEDULER_SA_EMAIL;
  const expectedSecret = "test-cron-secret-nodots";
  process.env.CRON_SECRET = expectedSecret;
  process.env.NEXTAUTH_URL = "https://somosvelora.com";

  const { verifyCronAuth } = reloadCronAuth();
  const req = mockNextReq(`Bearer ${expectedSecret}`);
  const result = await verifyCronAuth(req, "test-scope");

  // Restore
  if (savedSA !== undefined) process.env.CLOUD_SCHEDULER_SA_EMAIL = savedSA;
  if (savedSecret !== undefined) process.env.CRON_SECRET = savedSecret;
  else delete process.env.CRON_SECRET;
  if (savedNextauth !== undefined) process.env.NEXTAUTH_URL = savedNextauth;
  else delete process.env.NEXTAUTH_URL;

  assert.equal(result, null, "bearer secret must still work when CLOUD_SCHEDULER_SA_EMAIL unset");
});

test("cron-auth source: OIDC branch requires allowedEmail before accepting", () => {
  const src = fs.readFileSync(CRON_AUTH_PATH, "utf8");
  // The fix adds a fail-closed guard when allowedEmail is null
  assert.ok(
    src.includes("if (!allowedEmail)"),
    "cron-auth must fail-closed when CLOUD_SCHEDULER_SA_EMAIL unset"
  );
  assert.ok(
    src.includes("oidc_sa_email_not_configured"),
    "must return reason 'oidc_sa_email_not_configured' when SA email unset"
  );
});

// ── M3 — Andreani dedup uses transaction ─────────────────────────────────

test("Andreani webhook: uses prisma.$transaction with Serializable isolation for atomic dedup+update", () => {
  const src = fs.readFileSync(
    path.resolve(__dirname, "../../src/app/api/agents/andreani/webhook/route.ts"),
    "utf8",
  );
  assert.ok(
    src.includes("prisma.$transaction"),
    "Andreani webhook must use prisma.$transaction for atomic dedup"
  );
  assert.ok(
    src.includes("tx.andreaniShipment.findUnique"),
    "dedup read must happen inside the transaction via tx"
  );
  assert.ok(
    src.includes("tx.andreaniShipment.update"),
    "update must happen inside the transaction via tx"
  );
  assert.ok(
    src.includes("Serializable"),
    "transaction must use Serializable isolation to prevent concurrent duplicate writes (READ COMMITTED is insufficient)"
  );
});

test("Andreani webhook: outer findUnique does not fetch events (events re-read in tx)", () => {
  const src = fs.readFileSync(
    path.resolve(__dirname, "../../src/app/api/agents/andreani/webhook/route.ts"),
    "utf8",
  );
  // The outer findUnique should only select businessId (not events)
  // Confirm 'events: true' doesn't appear in the outer (pre-transaction) select block
  const outerPart = src.split("prisma.$transaction")[0];
  assert.ok(
    !outerPart.includes("events: true"),
    "outer findUnique must not fetch events — events are read inside the transaction"
  );
});
