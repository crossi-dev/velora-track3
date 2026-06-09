// Unit tests — Employee session version (sv) revocation.
//
// signEmployeeSession embeds an `sv` field (Employee.sessionVersion) into the
// HMAC cookie payload. verifyEmployeeSession (Node version) validates that
// the `sv` field is present and is a number — old cookies without sv return null.
//
// The DB-side check (sv must match Employee.sessionVersion) happens in
// resolveActor. This suite covers the crypto layer only: does the cookie
// carry a valid sv field, and does verifyEmployeeSession enforce its presence?

"use strict";

process.env.AUTH_SECRET =
  process.env.AUTH_SECRET || "test-employee-session-version-32b!";
process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgresql://test:test@localhost:5432/test";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createHmac } = require("node:crypto");

const {
  signEmployeeSession,
  verifyEmployeeSession,
} = require("../../src/lib/employee-auth.ts");

// ── Helpers ────────────────────────────────────────────────────────────────────

function signCookieRaw(payload) {
  // Mirror signEmployeeSession logic to produce crafted tokens.
  const secret = process.env.AUTH_SECRET;
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", secret).update(payloadB64).digest("base64url");
  return `${payloadB64}.${sig}`;
}

// ── Tests ──────────────────────────────────────────────────────────────────────

test("sv field: valid cookie with current sv → verifyEmployeeSession returns payload with sv", () => {
  const token = signEmployeeSession({
    employeeId: "emp-1",
    businessId: "biz-1",
    role: "cashier",
    sv: 3,
  });
  const decoded = verifyEmployeeSession(token);
  assert.ok(decoded !== null, "valid cookie must decode");
  assert.equal(decoded.sv, 3, "sv field must be preserved in payload");
});

test("sv field: sv=0 (initial version) → accepted", () => {
  const token = signEmployeeSession({
    employeeId: "emp-2",
    businessId: "biz-1",
    role: "cashier",
    sv: 0,
  });
  const decoded = verifyEmployeeSession(token);
  assert.ok(decoded !== null);
  assert.equal(decoded.sv, 0);
});

test("sv field: cookie without sv (old format) → rejected (returns null)", () => {
  // Craft a payload that lacks the `sv` field — simulates a pre-sv cookie.
  const payload = {
    employeeId: "emp-3",
    businessId: "biz-1",
    role: "cashier",
    exp: Date.now() + 60_000,
    // sv intentionally absent
  };
  const token = signCookieRaw(payload);
  const result = verifyEmployeeSession(token);
  assert.equal(result, null, "cookie without sv must be rejected");
});

test("sv field: sv as string (wrong type) → rejected", () => {
  const payload = {
    employeeId: "emp-4",
    businessId: "biz-1",
    role: "cashier",
    exp: Date.now() + 60_000,
    sv: "1", // string instead of number
  };
  const token = signCookieRaw(payload);
  const result = verifyEmployeeSession(token);
  assert.equal(result, null, "sv must be a number — string sv must be rejected");
});

test("sv field: increment scenario — stale sv in cookie should be detectable by caller", () => {
  // This test verifies that the cookie embeds a specific sv and the caller
  // can compare it against the DB. The verifyEmployeeSession layer itself
  // only validates presence+type; the stale-version logic lives in resolveActor.
  // Here we confirm the sv is faithfully round-tripped so resolveActor can use it.
  const svAtLogin = 5;
  const token = signEmployeeSession({
    employeeId: "emp-5",
    businessId: "biz-1",
    role: "cashier",
    sv: svAtLogin,
  });
  const decoded = verifyEmployeeSession(token);
  assert.ok(decoded !== null);

  // Simulate DB version has been bumped (admin revoked all sessions).
  const dbVersion = 6;
  // Caller (resolveActor) would do: if (decoded.sv !== dbVersion) → reject.
  assert.notEqual(decoded.sv, dbVersion, "stale sv detected — caller must reject");
  assert.equal(decoded.sv, svAtLogin, "cookie sv preserved for comparison");
});

test("sv field: sv=null → rejected (null is not a number)", () => {
  const payload = {
    employeeId: "emp-6",
    businessId: "biz-1",
    role: "cashier",
    exp: Date.now() + 60_000,
    sv: null,
  };
  const token = signCookieRaw(payload);
  const result = verifyEmployeeSession(token);
  assert.equal(result, null, "null sv must be rejected");
});
