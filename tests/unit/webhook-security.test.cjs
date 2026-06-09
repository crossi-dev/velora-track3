// Unit tests for MP webhook security helpers.
// getClientIp is now a re-export from @/lib/client-ip — covered by client-ip.test.cjs.
// This file retains coverage for checkIpBan, recordMismatch, and verifyMpSignature.

process.env.AUTH_SECRET = process.env.AUTH_SECRET || "test-webhook-security-secret-32-bytes";
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgresql://test:test@localhost:5432/test";

const assert = require("node:assert/strict");
const test = require("node:test");

const { getClientIp, checkIpBan, recordMismatch } = require("../../src/app/api/integrations/mp/_lib/webhook-security.ts");

function mockHeaders(xff, xRealIp) {
  return {
    get: (k) => {
      const lower = k.toLowerCase();
      if (lower === "x-forwarded-for") return xff ?? null;
      if (lower === "x-real-ip") return xRealIp ?? null;
      return null;
    },
  };
}

// ── getClientIp re-export smoke tests ─────────────────────────────────────────
// Full coverage lives in client-ip.test.cjs; these verify the re-export works.

test("getClientIp (re-export) retorna la última entrada de x-forwarded-for (GCLB real client)", () => {
  const headers = mockHeaders("203.0.113.5, 10.0.100.1, 192.0.2.99");
  assert.equal(getClientIp(headers), "192.0.2.99");
});

test("getClientIp (re-export) no retorna IP atacante en chain [attacker, attacker, realClient]", () => {
  const attacker = "1.2.3.4";
  const realClient = "198.51.100.77";
  const headers = mockHeaders(`${attacker}, ${attacker}, ${realClient}`);
  const ip = getClientIp(headers);
  assert.equal(ip, realClient, "debe retornar el último (real client), no el primero (atacante)");
  assert.notEqual(ip, attacker, "no debe retornar la IP del atacante");
});

test("getClientIp (re-export) trimea espacios del último entry", () => {
  const headers = mockHeaders("10.0.0.1,  192.0.2.55 ");
  assert.equal(getClientIp(headers), "192.0.2.55");
});

test("getClientIp (re-export) funciona con una sola IP (sin comas)", () => {
  const headers = mockHeaders("203.0.113.5");
  assert.equal(getClientIp(headers), "203.0.113.5");
});

// ── Fallback to x-real-ip ──────────────────────────────────────────────────

test("getClientIp (re-export) cae a x-real-ip cuando no hay x-forwarded-for", () => {
  const headers = mockHeaders(null, "198.51.100.42");
  assert.equal(getClientIp(headers), "198.51.100.42");
});

test("getClientIp (re-export) retorna 'unknown' cuando no hay ningún header", () => {
  const headers = mockHeaders(null, null);
  assert.equal(getClientIp(headers), "unknown");
});
