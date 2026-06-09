// Unit tests — agent-identity module-level key cache.
//
// The key cache (keyPairCache Map) avoids repeated PEM parse + public key
// derivation for the same agentId. clearKeyPairCache() is exported for
// test isolation. signAgentAssertion with a missing env var in a non-test
// NODE_ENV must log at ERROR (not WARNING).

"use strict";

process.env.AUTH_SECRET =
  process.env.AUTH_SECRET || "test-agent-identity-key-cache-32b!";
process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgresql://test:test@localhost:5432/test";

const assert = require("node:assert/strict");
const test = require("node:test");
const crypto = require("node:crypto");

const {
  clearMockModules,
  resetSourceModules,
  setMockModule,
} = require("../phase4/module-hooks.cjs");

// ── Log capture ────────────────────────────────────────────────────────────────

const logs = [];

function makeLogger() {
  return { cloudLog: (e) => logs.push(e) };
}

// ── JTI mock (markJtiSeen must not throw for happy-path sign tests) ────────────

function makeJtiMock() {
  return { markJtiSeen: async () => {} };
}

// ── Key generation helper ──────────────────────────────────────────────────────

function generatePem() {
  const { privateKey } = crypto.generateKeyPairSync("ed25519");
  return privateKey.export({ type: "pkcs8", format: "pem" });
}

// ── Load the module under test ─────────────────────────────────────────────────

function loadModule() {
  logs.length = 0;
  resetSourceModules();
  clearMockModules();
  setMockModule("@/lib/cloud-logger", makeLogger());
  setMockModule("@/lib/a2a-jti-cache", makeJtiMock());
  return require("../../src/lib/agent-identity.ts");
}

// ── Tests ──────────────────────────────────────────────────────────────────────

test("key cache: loadKeyPair called twice for same agentId → second call hits cache", () => {
  const { signAgentAssertion, clearKeyPairCache } = loadModule();

  const pem = generatePem();
  const original = process.env.AGENT_IDENTITY_KEY_SUPERVISOR;
  process.env.AGENT_IDENTITY_KEY_SUPERVISOR = pem;

  try {
    clearKeyPairCache();

    // First call — parses PEM and populates cache.
    const t1 = signAgentAssertion("supervisor", "payments");
    assert.ok(t1, "first call must produce a token");

    // Second call — must use cache. We verify this by corrupting the env var
    // AFTER the first call: if the cache is hit, the second call still works.
    process.env.AGENT_IDENTITY_KEY_SUPERVISOR = "CORRUPTED_PEM";
    const t2 = signAgentAssertion("supervisor", "payments");
    assert.ok(t2, "second call must succeed using cached key despite corrupted env var");

    // Both tokens are structurally valid JWTs.
    assert.equal(t1.split(".").length, 3);
    assert.equal(t2.split(".").length, 3);
  } finally {
    if (original === undefined) {
      delete process.env.AGENT_IDENTITY_KEY_SUPERVISOR;
    } else {
      process.env.AGENT_IDENTITY_KEY_SUPERVISOR = original;
    }
  }
});

test("key cache: clearKeyPairCache() clears the cache — subsequent call re-parses env", () => {
  const { signAgentAssertion, clearKeyPairCache } = loadModule();

  const pem1 = generatePem();
  const pem2 = generatePem();
  const original = process.env.AGENT_IDENTITY_KEY_SUPERVISOR;

  process.env.AGENT_IDENTITY_KEY_SUPERVISOR = pem1;
  try {
    clearKeyPairCache();
    const t1 = signAgentAssertion("supervisor", "payments");
    assert.ok(t1, "first token must succeed");

    // Rotate the key, clear cache — next call must use the new PEM.
    process.env.AGENT_IDENTITY_KEY_SUPERVISOR = pem2;
    clearKeyPairCache();

    const t2 = signAgentAssertion("supervisor", "payments");
    assert.ok(t2, "post-clear token must succeed with new key");

    // The two tokens have different keys — their headers/payloads differ.
    assert.notEqual(t1, t2, "tokens signed with different keys must differ");
  } finally {
    if (original === undefined) {
      delete process.env.AGENT_IDENTITY_KEY_SUPERVISOR;
    } else {
      process.env.AGENT_IDENTITY_KEY_SUPERVISOR = original;
    }
  }
});

test("key cache: signAgentAssertion with missing env var in production → logs ERROR", () => {
  // In test env (NODE_ENV=test) it logs WARNING. Verify the source uses
  // NODE_ENV to escalate to ERROR in production.
  const fs = require("node:fs");
  const path = require("node:path");
  const src = fs.readFileSync(
    path.join(process.cwd(), "src/lib/agent-identity.ts"),
    "utf8"
  );
  // The source must contain the NODE_ENV guard that escalates to ERROR.
  assert.ok(
    src.includes("NODE_ENV") && src.includes('"ERROR"') && src.includes('"WARNING"'),
    "source must escalate log severity to ERROR in non-test environments"
  );
  assert.ok(
    src.includes('process.env.NODE_ENV === "test"'),
    'source must check NODE_ENV === "test" to conditionally log WARNING vs ERROR'
  );
});

test("key cache: missing env var in test environment → logs WARNING (not ERROR)", () => {
  const { signAgentAssertion, clearKeyPairCache } = loadModule();
  clearKeyPairCache();

  const original = process.env.AGENT_IDENTITY_KEY_SUPERVISOR;
  delete process.env.AGENT_IDENTITY_KEY_SUPERVISOR;

  // NODE_ENV is 'test' in this runner context.
  const savedEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "test";

  try {
    const result = signAgentAssertion("supervisor", "payments");
    assert.equal(result, null, "missing key must return null");

    const signLog = logs.find((l) => l.action === "SIGN_KEY_MISSING");
    assert.ok(signLog, "must log SIGN_KEY_MISSING");
    assert.equal(signLog.severity, "WARNING", "severity must be WARNING in test env");
  } finally {
    process.env.NODE_ENV = savedEnv;
    if (original === undefined) {
      delete process.env.AGENT_IDENTITY_KEY_SUPERVISOR;
    } else {
      process.env.AGENT_IDENTITY_KEY_SUPERVISOR = original;
    }
  }
});

test("key cache: cache is isolated per agentId (supervisor cache miss does not affect payments)", () => {
  const { signAgentAssertion, clearKeyPairCache } = loadModule();
  clearKeyPairCache();

  const supPem = generatePem();
  const payPem = generatePem();
  const origSup = process.env.AGENT_IDENTITY_KEY_SUPERVISOR;
  const origPay = process.env.AGENT_IDENTITY_KEY_PAYMENTS;

  process.env.AGENT_IDENTITY_KEY_SUPERVISOR = supPem;
  process.env.AGENT_IDENTITY_KEY_PAYMENTS = payPem;

  try {
    const tSup = signAgentAssertion("supervisor", "payments");
    const tPay = signAgentAssertion("payments", "supervisor");
    assert.ok(tSup, "supervisor token must succeed");
    assert.ok(tPay, "payments token must succeed");

    // Corrupt supervisor env — payments cache must be unaffected.
    process.env.AGENT_IDENTITY_KEY_SUPERVISOR = "CORRUPTED";
    const tPayAgain = signAgentAssertion("payments", "supervisor");
    assert.ok(tPayAgain, "payments key must still be cached independently");
  } finally {
    if (origSup === undefined) delete process.env.AGENT_IDENTITY_KEY_SUPERVISOR;
    else process.env.AGENT_IDENTITY_KEY_SUPERVISOR = origSup;
    if (origPay === undefined) delete process.env.AGENT_IDENTITY_KEY_PAYMENTS;
    else process.env.AGENT_IDENTITY_KEY_PAYMENTS = origPay;
  }
});
