// Unit tests for business-resolver.ts
//
// Tests:
//   1. Meta + phoneNumberId → WabaConnection match → resolves via phone_number_id
//   2. Meta + phoneNumberId → no WabaConnection → null + WARNING log
//   3. Meta + no phoneNumberId → null + WARNING log
//   4. Twilio + STEP5_BRIDGE_BUSINESS_ID set → resolves via twilio_bridge
//   5. Twilio + STEP5_BRIDGE_BUSINESS_ID NOT set → null + WARNING log
//   6. DB error on WabaConnection lookup → null + ERROR log
//
// Pattern: setMockModule + resetSourceModules (module-hooks.cjs) — same as
// customer-agent-rpc.test.cjs. Prisma is fully mocked per test.

"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const Module = require("node:module");
const path = require("node:path");

const { setMockModule, clearMockModules, resetSourceModules } = require("../phase4/module-hooks.cjs");

const SUT_PATH = path.resolve(
  __dirname,
  "../../src/app/api/whatsapp/_lib/business-resolver.ts",
);

// ── Helpers ────────────────────────────────────────────────────────────────────

let logCalls = [];

function installMocks({ wabaResult = null, wabaThrow = null } = {}) {
  logCalls = [];
  clearMockModules();
  resetSourceModules();

  setMockModule("@/lib/cloud-logger", {
    cloudLog: (entry) => { logCalls.push(entry); },
  });

  setMockModule("@/lib/prisma", {
    prisma: {
      wabaConnection: {
        findFirst: async () => {
          if (wabaThrow) throw wabaThrow;
          return wabaResult;
        },
      },
    },
  });
}

function loadSut() {
  delete Module._cache[SUT_PATH];
  return require(SUT_PATH);
}

function resetEnv(key) {
  delete process.env[key];
}

// ── Tests ──────────────────────────────────────────────────────────────────────

test("Meta + phoneNumberId → WabaConnection match → resolves via phone_number_id", async () => {
  installMocks({ wabaResult: { businessId: "biz-abc123" } });
  const { resolveBusinessForInbound } = loadSut();

  const result = await resolveBusinessForInbound({
    provider: "meta",
    toPhoneNumberId: "12345678",
  });

  assert.deepEqual(result, { businessId: "biz-abc123", via: "phone_number_id" });
});

test("Meta + phoneNumberId → no WabaConnection → null + WARNING log", async () => {
  installMocks({ wabaResult: null });
  const { resolveBusinessForInbound } = loadSut();

  const result = await resolveBusinessForInbound({
    provider: "meta",
    toPhoneNumberId: "99999999",
  });

  assert.equal(result, null);
  assert.ok(
    logCalls.some((e) => e.severity === "WARNING" && e.action === "WEBHOOK_RESOLVE_NO_WABA"),
    "Expected WARNING log for missing WabaConnection",
  );
});

test("Meta + no phoneNumberId → null + WARNING log", async () => {
  installMocks();
  const { resolveBusinessForInbound } = loadSut();

  const result = await resolveBusinessForInbound({
    provider: "meta",
    toPhoneNumberId: null,
  });

  assert.equal(result, null);
  assert.ok(
    logCalls.some((e) => e.severity === "WARNING" && e.action === "WEBHOOK_RESOLVE_SKIP"),
    "Expected WARNING WEBHOOK_RESOLVE_SKIP log",
  );
});

test("Meta + undefined phoneNumberId → null", async () => {
  installMocks();
  const { resolveBusinessForInbound } = loadSut();

  // toPhoneNumberId omitted (undefined)
  const result = await resolveBusinessForInbound({ provider: "meta" });
  assert.equal(result, null);
});

test("Twilio + STEP5_BRIDGE_BUSINESS_ID set → resolves via twilio_bridge", async () => {
  installMocks();
  process.env.STEP5_BRIDGE_BUSINESS_ID = "demo-business-id";
  try {
    const { resolveBusinessForInbound } = loadSut();

    const result = await resolveBusinessForInbound({
      provider: "twilio",
      toPhoneE164: "+14155238886",
    });

    assert.deepEqual(result, {
      businessId: "demo-business-id",
      via: "twilio_bridge",
    });
  } finally {
    resetEnv("STEP5_BRIDGE_BUSINESS_ID");
  }
});

test("Twilio + STEP5_BRIDGE_BUSINESS_ID NOT set → null + WARNING log", async () => {
  resetEnv("STEP5_BRIDGE_BUSINESS_ID");
  installMocks();
  const { resolveBusinessForInbound } = loadSut();

  const result = await resolveBusinessForInbound({
    provider: "twilio",
    toPhoneE164: "+14155238886",
  });

  assert.equal(result, null);
  assert.ok(
    logCalls.some((e) => e.severity === "WARNING" && e.action === "WEBHOOK_RESOLVE_TWILIO_NO_BRIDGE"),
    "Expected WARNING WEBHOOK_RESOLVE_TWILIO_NO_BRIDGE log",
  );
});

test("DB error on WabaConnection lookup → null + ERROR log", async () => {
  const dbErr = new Error("Connection refused");
  installMocks({ wabaThrow: dbErr });
  const { resolveBusinessForInbound } = loadSut();

  const result = await resolveBusinessForInbound({
    provider: "meta",
    toPhoneNumberId: "12345678",
  });

  assert.equal(result, null);
  assert.ok(
    logCalls.some((e) => e.severity === "ERROR" && e.action === "WEBHOOK_RESOLVE_DB_ERROR"),
    "Expected ERROR WEBHOOK_RESOLVE_DB_ERROR log",
  );
});
