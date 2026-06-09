// Unit tests for the shared getClientIp helper.
// Covers rightmost-trust (GCLB topology), x-real-ip fallback, and "unknown" sentinel.

const assert = require("node:assert/strict");
const test = require("node:test");

const { getClientIp } = require("../../src/lib/client-ip.ts");

function makeHeaders(xff, xRealIp) {
  return {
    get(name) {
      const k = name.toLowerCase();
      if (k === "x-forwarded-for") return xff ?? null;
      if (k === "x-real-ip") return xRealIp ?? null;
      return null;
    },
  };
}

// ── X-Forwarded-For: rightmost entry is the real client (GCLB appends it) ──

test("getClientIp: single IP in x-forwarded-for returns that IP", () => {
  assert.equal(getClientIp(makeHeaders("203.0.113.5", null)), "203.0.113.5");
});

test("getClientIp: comma-separated chain — returns LAST entry (GCLB client IP)", () => {
  // Chain: spoofed-by-attacker, internal-hop, real-client (appended by GCLB)
  assert.equal(
    getClientIp(makeHeaders("1.2.3.4, 10.0.100.1, 192.0.2.99", null)),
    "192.0.2.99"
  );
});

test("getClientIp: trims whitespace from last entry", () => {
  assert.equal(getClientIp(makeHeaders("10.0.0.1,  192.0.2.55 ", null)), "192.0.2.55");
});

test("getClientIp: does NOT return attacker-supplied first entry", () => {
  const ip = getClientIp(makeHeaders("evil-ip, real-client", null));
  assert.equal(ip, "real-client");
  assert.notEqual(ip, "evil-ip");
});

// ── x-real-ip fallback ───────────────────────────────────────────────────────

test("getClientIp: falls back to x-real-ip when x-forwarded-for is absent", () => {
  assert.equal(getClientIp(makeHeaders(null, "198.51.100.42")), "198.51.100.42");
});

// ── "unknown" sentinel ───────────────────────────────────────────────────────

test("getClientIp: returns 'unknown' when no headers are present", () => {
  assert.equal(getClientIp(makeHeaders(null, null)), "unknown");
});
