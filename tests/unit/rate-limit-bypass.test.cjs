// Tests that bypass=true in checkRateLimit always allows the request,
// and that normal enforcement still works when bypass is false/absent.

process.env.AUTH_SECRET = process.env.AUTH_SECRET || "test-rate-limit-bypass-secret-32b!";
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgresql://test:test@localhost:5432/test";

const assert = require("node:assert/strict");
const test = require("node:test");

const { checkRateLimit, bypassIfTester } = require("../../src/app/api/_lib/route-helpers.ts");

function mockReq(ip = "10.99.0.1") {
  const headers = new Map([["x-forwarded-for", ip]]);
  return {
    headers: { get: (k) => headers.get(k.toLowerCase()) ?? null },
  };
}

// ── bypass=true always allows ─────────────────────────────────────────────

test("bypass=true: first request is allowed", () => {
  const res = checkRateLimit(mockReq("10.99.1.1"), "bypass-test", 1, 60, { bypass: true });
  assert.equal(res, null);
});

test("bypass=true: 100 requests are all allowed even though limit is 1", () => {
  const ip = "10.99.1.2";
  for (let i = 0; i < 100; i++) {
    const res = checkRateLimit(mockReq(ip), "bypass-test-100", 1, 60, { bypass: true });
    assert.equal(res, null, `request ${i + 1} should be allowed with bypass`);
  }
});

test("bypass=false: enforces limit normally (1 req/min)", () => {
  const ip = "10.99.2.1";
  const first = checkRateLimit(mockReq(ip), "no-bypass-scope", 1, 60, { bypass: false });
  assert.equal(first, null, "first request should pass");

  const second = checkRateLimit(mockReq(ip), "no-bypass-scope", 1, 60, { bypass: false });
  assert.ok(second !== null, "second request should be blocked");
  assert.equal(second.status, 429);
});

test("bypass omitted: enforces limit normally (1 req/min)", () => {
  const ip = "10.99.3.1";
  const first = checkRateLimit(mockReq(ip), "no-bypass-omit", 1, 60);
  assert.equal(first, null, "first request should pass");

  const second = checkRateLimit(mockReq(ip), "no-bypass-omit", 1, 60);
  assert.ok(second !== null, "second request should be blocked");
  assert.equal(second.status, 429);
});

// ── bypassIfTester helper ─────────────────────────────────────────────────

test("bypassIfTester: returns {bypass:true} when isTester=true", () => {
  const result = bypassIfTester({ isTester: true });
  assert.deepEqual(result, { bypass: true });
});

test("bypassIfTester: returns {bypass:false} when isTester=false", () => {
  const result = bypassIfTester({ isTester: false });
  assert.deepEqual(result, { bypass: false });
});

test("bypassIfTester: returns {bypass:false} when isTester is absent", () => {
  const result = bypassIfTester({});
  assert.deepEqual(result, { bypass: false });
});

test("bypassIfTester: returns {bypass:false} for null actor", () => {
  const result = bypassIfTester(null);
  assert.deepEqual(result, { bypass: false });
});

test("bypassIfTester: returns {bypass:false} for undefined actor", () => {
  const result = bypassIfTester(undefined);
  assert.deepEqual(result, { bypass: false });
});
