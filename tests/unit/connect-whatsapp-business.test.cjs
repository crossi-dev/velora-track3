"use strict";

// Unit tests for connect_whatsapp_business tool (Step 1.5c).
//
// Covers:
//   1. isValidE164: valid E.164 numbers accepted.
//   2. isValidE164: invalid inputs rejected.
//   3. connectWhatsappBusiness: returns error for invalid E.164 input.
//   4. connectWhatsappBusiness: calls /api/business PATCH and succeeds.
//   5. connectWhatsappBusiness: propagates HTTP error from /api/business.
//   6. connectWhatsappBusiness: handles network exception.
//   7. connectWhatsappBusiness: trims whitespace from phoneE164 before saving.
//
// Source — Stripe Incremental currently_due pattern:
//   https://docs.stripe.com/connect/custom/hosted-onboarding
// Source — E.164 format reference:
//   https://www.itu.int/rec/T-REC-E.164

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  clearMockModules,
  resetSourceModules,
  setMockModule,
} = require("../phase4/module-hooks.cjs");

// ── Fake cloud-logger ─────────────────────────────────────────────────────────

function makeFakeCloudLog() {
  const calls = [];
  return {
    cloudLog: (...args) => { calls.push(args); },
    calls,
  };
}

// ── Load module helper ────────────────────────────────────────────────────────

function loadModule({ fetchOverride, cloudLogFake } = {}) {
  resetSourceModules();
  clearMockModules();

  setMockModule("@/lib/cloud-logger", cloudLogFake ?? makeFakeCloudLog());

  if (fetchOverride) {
    // Inject as global.fetch so the module's fetch() call picks it up.
    global.fetch = fetchOverride;
  }

  return require(
    "../../src/app/api/business-assistant/_lib/onboarding-agent.tools.whatsapp.ts"
  );
}

// ── Shared fake ToolContext ───────────────────────────────────────────────────

function fakeCtx() {
  return {
    businessId: "biz_test",
    actorUserId: "usr_test",
    idempotencySeed: "seed_test",
  };
}

// ── 1. isValidE164: valid numbers ─────────────────────────────────────────────

test("isValidE164: accepts valid E.164 numbers", () => {
  const { isValidE164 } = loadModule();

  // Argentina mobile
  assert.equal(isValidE164("+5491100000000"), true);
  // US number
  assert.equal(isValidE164("+12025551234"), true);
  // Shortest valid (7 digits after +)
  assert.equal(isValidE164("+1234567"), true);
  // Longest valid (15 digits after +)
  assert.equal(isValidE164("+123456789012345"), true);
});

// ── 2. isValidE164: invalid inputs ───────────────────────────────────────────

test("isValidE164: rejects invalid inputs", () => {
  const { isValidE164 } = loadModule();

  assert.equal(isValidE164("5491100000000"), false);    // missing +
  assert.equal(isValidE164("+549"), false);             // too short (3 digits)
  assert.equal(isValidE164("+1234567890123456"), false); // too long (16 digits)
  assert.equal(isValidE164("+54911abc0000"), false);    // non-digit chars
  assert.equal(isValidE164(""), false);                 // empty
  assert.equal(isValidE164("not-a-phone"), false);      // garbage
});

// ── 3. connectWhatsappBusiness: invalid E.164 → error result ─────────────────

test("connectWhatsappBusiness: invalid phoneE164 returns error without calling fetch", async () => {
  let fetchCalled = false;
  const logFake = makeFakeCloudLog();

  const { connectWhatsappBusiness } = loadModule({
    fetchOverride: async () => { fetchCalled = true; },
    cloudLogFake: logFake,
  });

  const result = await connectWhatsappBusiness({ phoneE164: "not-e164" }, fakeCtx());

  assert.equal(result.ok, false);
  assert.equal(result.phoneE164, null);
  assert.equal(result.wasFirstCapture, false);
  assert.ok(result.error?.includes("E.164"), `expected E.164 mention in error: ${result.error}`);
  assert.equal(fetchCalled, false, "fetch must NOT be called for invalid input");
});

// ── 4. connectWhatsappBusiness: HTTP 200 success ──────────────────────────────

test("connectWhatsappBusiness: valid phone + HTTP 200 → success result", async () => {
  const fakeFetch = async (url, opts) => {
    assert.ok(url.endsWith("/api/business"), `expected /api/business endpoint, got: ${url}`);
    assert.equal(opts.method, "PATCH");
    const body = JSON.parse(opts.body);
    assert.equal(body.whatsappBusinessPhoneE164, "+5491100000000");
    return { ok: true, json: async () => ({ ok: true }) };
  };

  const { connectWhatsappBusiness } = loadModule({ fetchOverride: fakeFetch });

  const result = await connectWhatsappBusiness({ phoneE164: "+5491100000000" }, fakeCtx());

  assert.equal(result.ok, true);
  assert.equal(result.phoneE164, "+5491100000000");
  assert.equal(result.wasFirstCapture, true);
  assert.equal(result.confirmation, "WhatsApp Business número guardado.");
  assert.equal(result.error, null);
});

// ── 5. connectWhatsappBusiness: HTTP error → failure result ──────────────────

test("connectWhatsappBusiness: HTTP 500 from /api/business → error result", async () => {
  const fakeFetch = async () => ({
    ok: false,
    status: 500,
    json: async () => ({ message: "Internal server error" }),
  });

  const { connectWhatsappBusiness } = loadModule({ fetchOverride: fakeFetch });

  const result = await connectWhatsappBusiness({ phoneE164: "+5491100000000" }, fakeCtx());

  assert.equal(result.ok, false);
  assert.equal(result.phoneE164, null);
  assert.ok(result.error?.includes("Internal server error"), `expected error message, got: ${result.error}`);
});

// ── 6. connectWhatsappBusiness: network exception → error result ──────────────

test("connectWhatsappBusiness: fetch throws → error result (no unhandled rejection)", async () => {
  const fakeFetch = async () => { throw new Error("Network failure"); };

  const { connectWhatsappBusiness } = loadModule({ fetchOverride: fakeFetch });

  const result = await connectWhatsappBusiness({ phoneE164: "+5491100000000" }, fakeCtx());

  assert.equal(result.ok, false);
  assert.equal(result.phoneE164, null);
  assert.ok(result.error?.includes("Network failure"), `expected error message, got: ${result.error}`);
});

// ── 7. connectWhatsappBusiness: trims whitespace before save ──────────────────

test("connectWhatsappBusiness: trims leading/trailing whitespace from phoneE164", async () => {
  let capturedBody = null;
  const fakeFetch = async (url, opts) => {
    capturedBody = JSON.parse(opts.body);
    return { ok: true, json: async () => ({ ok: true }) };
  };

  const { connectWhatsappBusiness } = loadModule({ fetchOverride: fakeFetch });

  const result = await connectWhatsappBusiness(
    { phoneE164: "  +5491100000000  " },
    fakeCtx(),
  );

  assert.equal(result.ok, true);
  assert.equal(result.phoneE164, "+5491100000000");
  assert.equal(capturedBody?.whatsappBusinessPhoneE164, "+5491100000000");
});
