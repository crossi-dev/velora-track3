const assert = require("node:assert/strict");
const test = require("node:test");

// Set AUTH_SECRET BEFORE the module loads — signEmployeeSession reads it at call time.
process.env.AUTH_SECRET = "test-auth-secret-32bytes-of-stuff!!";

const {
  hashPin,
  verifyPin,
  signEmployeeSession,
  verifyEmployeeSession,
  businessLoginToken,
  EmployeeAuthError,
  EMPLOYEE_COOKIE_NAME,
} = require("../../src/lib/employee-auth.ts");

// ── PIN hashing ───────────────────────────────────────────────────────

test("hashPin: generates different hashes for same PIN (salt randomness)", () => {
  const a = hashPin("1234");
  const b = hashPin("1234");
  assert.notEqual(a, b);
  assert.match(a, /^v1\$[0-9a-f]+\$[0-9a-f]+$/);
});

test("hashPin: rejects PINs shorter than 4 or longer than 12", () => {
  assert.throws(() => hashPin("123"), EmployeeAuthError);
  assert.throws(() => hashPin("0123456789012"), EmployeeAuthError);
  assert.throws(() => hashPin(""), EmployeeAuthError);
});

test("hashPin: rejects non-string input", () => {
  assert.throws(() => hashPin(1234), EmployeeAuthError);
  assert.throws(() => hashPin(null), EmployeeAuthError);
});

test("verifyPin: returns true for correct PIN", () => {
  const hash = hashPin("9876");
  assert.equal(verifyPin("9876", hash), true);
});

test("verifyPin: returns false for wrong PIN", () => {
  const hash = hashPin("9876");
  assert.equal(verifyPin("1234", hash), false);
});

test("verifyPin: returns false on malformed hash (no version)", () => {
  assert.equal(verifyPin("1234", "garbage"), false);
});

test("verifyPin: returns false on hash with wrong version prefix", () => {
  const hash = hashPin("1234");
  const tampered = hash.replace("v1$", "v0$");
  assert.equal(verifyPin("1234", tampered), false);
});

test("verifyPin: returns false on truncated hash", () => {
  const hash = hashPin("1234");
  const truncated = hash.slice(0, 20);
  assert.equal(verifyPin("1234", truncated), false);
});

test("verifyPin: returns false for non-string inputs", () => {
  assert.equal(verifyPin(null, "x"), false);
  assert.equal(verifyPin("1234", null), false);
});

// ── Cookie sign/verify ────────────────────────────────────────────────

test("signEmployeeSession + verifyEmployeeSession: roundtrip preserves payload", () => {
  // sv (session revocation counter) is required by verifyEmployeeSession —
  // matches Employee.sessionVersion in prod. Any value is fine for the
  // roundtrip; the actual revocation check is done by callers, not in verify.
  const token = signEmployeeSession({
    employeeId: "emp-1",
    businessId: "biz-1",
    role: "cashier",
    sv: 0,
  });
  const decoded = verifyEmployeeSession(token);
  assert.ok(decoded, "expected verify to return a decoded payload, got null");
  assert.equal(decoded.employeeId, "emp-1");
  assert.equal(decoded.businessId, "biz-1");
  assert.equal(decoded.role, "cashier");
  assert.equal(decoded.sv, 0);
  assert.ok(decoded.exp > Date.now());
});

test("verifyEmployeeSession: returns null on null/undefined input", () => {
  assert.equal(verifyEmployeeSession(null), null);
  assert.equal(verifyEmployeeSession(undefined), null);
  assert.equal(verifyEmployeeSession(""), null);
});

test("verifyEmployeeSession: returns null on tampered signature", () => {
  const token = signEmployeeSession({ employeeId: "e", businessId: "b", role: "cashier" });
  const [payload] = token.split(".");
  const tampered = `${payload}.tampered-signature`;
  assert.equal(verifyEmployeeSession(tampered), null);
});

test("verifyEmployeeSession: returns null on tampered payload (signature mismatch)", () => {
  const token = signEmployeeSession({ employeeId: "e", businessId: "b", role: "cashier" });
  const [, sig] = token.split(".");
  const fakePayload = Buffer.from(JSON.stringify({ employeeId: "INTRUDER", businessId: "b", role: "manager", exp: Date.now() + 100000 })).toString("base64url");
  const tampered = `${fakePayload}.${sig}`;
  assert.equal(verifyEmployeeSession(tampered), null);
});

test("verifyEmployeeSession: returns null on malformed structure (no dot)", () => {
  assert.equal(verifyEmployeeSession("nodothere"), null);
});

test("verifyEmployeeSession: returns null on expired token", () => {
  // Manually craft an expired token signed with the same secret
  const expiredPayload = {
    employeeId: "e",
    businessId: "b",
    role: "cashier",
    exp: Date.now() - 1000,
  };
  const { createHmac } = require("node:crypto");
  const payloadB64 = Buffer.from(JSON.stringify(expiredPayload)).toString("base64url");
  const sig = createHmac("sha256", process.env.AUTH_SECRET).update(payloadB64).digest("base64url");
  const expiredToken = `${payloadB64}.${sig}`;
  assert.equal(verifyEmployeeSession(expiredToken), null);
});

// ── businessLoginToken ────────────────────────────────────────────────

test("businessLoginToken: deterministic for same businessId", () => {
  const a = businessLoginToken("biz-abc-123");
  const b = businessLoginToken("biz-abc-123");
  assert.equal(a, b);
});

test("businessLoginToken: different for different businessIds", () => {
  const a = businessLoginToken("biz-1");
  const b = businessLoginToken("biz-2");
  assert.notEqual(a, b);
});

test("businessLoginToken: 12-char output", () => {
  const token = businessLoginToken("biz-some-id");
  assert.equal(token.length, 12);
});

// ── Constants ─────────────────────────────────────────────────────────

test("EMPLOYEE_COOKIE_NAME is namespaced", () => {
  assert.match(EMPLOYEE_COOKIE_NAME, /velora-employee/);
});
