import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verifyEmployeeSession } from "@/lib/employee-auth-edge";

const TEST_SECRET = "test-secret-for-unit-tests-32chars!";

async function makeCookie(payload: object, secret = TEST_SECRET): Promise<string> {
  const encoder = new TextEncoder();
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sigBuf = await crypto.subtle.sign("HMAC", key, encoder.encode(payloadB64));
  const sigB64 = Buffer.from(new Uint8Array(sigBuf)).toString("base64url");
  return `${payloadB64}.${sigB64}`;
}

function futureExp(): number {
  return Date.now() + 3_600_000;
}

describe("verifyEmployeeSession", () => {
  beforeEach(() => {
    process.env.AUTH_SECRET = TEST_SECRET;
  });

  afterEach(() => {
    delete process.env.AUTH_SECRET;
  });

  it("returns null for null input", async () => {
    expect(await verifyEmployeeSession(null)).toBeNull();
  });

  it("returns null for undefined input", async () => {
    expect(await verifyEmployeeSession(undefined)).toBeNull();
  });

  it("returns null when AUTH_SECRET is absent", async () => {
    delete process.env.AUTH_SECRET;
    expect(await verifyEmployeeSession("anything.anything")).toBeNull();
  });

  it("returns null for a cookie with no dot separator", async () => {
    expect(await verifyEmployeeSession("nodothere")).toBeNull();
  });

  it("returns null when signature is tampered", async () => {
    const payload = { employeeId: "e1", businessId: "b1", role: "employee", exp: futureExp() };
    const cookie = await makeCookie(payload);
    const tampered = cookie.slice(0, -5) + "XXXXX";
    expect(await verifyEmployeeSession(tampered)).toBeNull();
  });

  it("returns null when cookie was signed with a different secret", async () => {
    const payload = { employeeId: "e1", businessId: "b1", role: "employee", exp: futureExp() };
    const cookie = await makeCookie(payload, "wrong-secret");
    expect(await verifyEmployeeSession(cookie)).toBeNull();
  });

  it("returns null for an expired cookie", async () => {
    const payload = { employeeId: "e1", businessId: "b1", role: "employee", exp: Date.now() - 1000 };
    const cookie = await makeCookie(payload);
    expect(await verifyEmployeeSession(cookie)).toBeNull();
  });

  it("returns the session payload for a valid unexpired cookie", async () => {
    const payload = { employeeId: "emp-123", businessId: "biz-456", role: "employee", exp: futureExp() };
    const cookie = await makeCookie(payload);
    const result = await verifyEmployeeSession(cookie);
    expect(result?.payload).toMatchObject({ employeeId: "emp-123", businessId: "biz-456", role: "employee" });
    expect(result?.shouldRefresh).toBe(false);
  });

  it("sets shouldRefresh when session expires within 30 minutes", async () => {
    const payload = { employeeId: "e1", businessId: "b1", role: "employee", exp: Date.now() + 10 * 60 * 1000 };
    const cookie = await makeCookie(payload);
    const result = await verifyEmployeeSession(cookie);
    expect(result?.shouldRefresh).toBe(true);
  });
});
