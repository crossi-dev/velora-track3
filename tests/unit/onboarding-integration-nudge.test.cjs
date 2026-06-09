"use strict";
// Tests for onboarding-integration-nudge.ts — shared proactive integration nudge helper.
// Covers: flag gate, skip-if-connected (TOCTOU fresh read), dismiss gate, dedup (P2002),
// and the happy-path "sent" result.

const assert = require("node:assert/strict");
const test = require("node:test");
const Module = require("node:module");
const path = require("node:path");

const SUT_PATH = path.resolve(__dirname, "../../src/app/api/_lib/onboarding-integration-nudge.ts");
const CLOUD_LOGGER_PATH = path.resolve(__dirname, "../../src/lib/cloud-logger.ts");
const TODAY_SUMMARY_PATH = path.resolve(__dirname, "../../src/app/dashboard/lib/today-summary.ts");

// ── Mock factories ────────────────────────────────────────────────────────────
// Mock state is passed as a bag so each test controls it independently.

function makePrisma(state) {
  return {
    business: {
      findUnique: async (...args) => state.bizFindUnique(...args),
      update: async () => ({}),
    },
    mpConnection: {
      findUnique: async (...args) => state.mpFindUnique ? state.mpFindUnique(...args) : null,
    },
    arcaCredential: {
      findUnique: async () => null,
    },
    courierCredential: {
      findFirst: async () => null,
    },
    chatMessage: {
      create: async (...args) => {
        state.chatCreates.push(args[0]);
        return {};
      },
    },
    $transaction: async (ops) => {
      state.txCalls.push(ops);
      const results = [];
      for (const op of ops) results.push(await op);
      return results;
    },
  };
}

function loadSut(flagValue, state) {
  // Clean prior SUT + dependencies from module cache.
  delete Module._cache[SUT_PATH];
  const prismaPath = require.resolve("@/lib/prisma");
  delete Module._cache[prismaPath];
  delete Module._cache[CLOUD_LOGGER_PATH];
  delete Module._cache[TODAY_SUMMARY_PATH];

  process.env.PROACTIVE_ONBOARDING_ENABLED = flagValue;

  const prisma = makePrisma(state);
  Module._cache[prismaPath] = {
    id: prismaPath, filename: prismaPath, loaded: true,
    exports: { prisma },
  };
  Module._cache[CLOUD_LOGGER_PATH] = {
    id: CLOUD_LOGGER_PATH, filename: CLOUD_LOGGER_PATH, loaded: true,
    exports: { cloudLog: () => {} },
  };
  Module._cache[TODAY_SUMMARY_PATH] = {
    id: TODAY_SUMMARY_PATH, filename: TODAY_SUMMARY_PATH, loaded: true,
    exports: { getArgentinaDateString: () => "2026-06-07" },
  };

  return { sut: require(SUT_PATH), prisma };
}

function makeState(overrides = {}) {
  return {
    bizFindUnique: async () => null,
    mpFindUnique: async () => null,
    chatCreates: [],
    txCalls: [],
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test("maybeSendIntegrationNudge: returns skip_flag_off when PROACTIVE_ONBOARDING_ENABLED is 'false'", async () => {
  const state = makeState();
  const { sut } = loadSut("false", state);
  const result = await sut.maybeSendIntegrationNudge({ businessId: "biz-001", integration: "mp" });
  assert.equal(result, "skip_flag_off");
});

test("maybeSendIntegrationNudge: returns skip_no_business when business row is null", async () => {
  const state = makeState({ bizFindUnique: async () => null });
  const { sut } = loadSut("true", state);
  const result = await sut.maybeSendIntegrationNudge({ businessId: "biz-missing", integration: "mp" });
  assert.equal(result, "skip_no_business");
});

test("maybeSendIntegrationNudge: returns skip_shown_today when NudgeShownAt is in today's ART slot", async () => {
  // getArgentinaDateString stub returns "2026-06-07", so a shownAt on that date triggers skip.
  const shownAt = new Date("2026-06-07T12:00:00Z");
  const state = makeState({
    bizFindUnique: async () => ({ mpNudgeShownAt: shownAt, mpNudgeDismissedAt: null }),
  });
  const { sut } = loadSut("true", state);
  const result = await sut.maybeSendIntegrationNudge({ businessId: "biz-001", integration: "mp" });
  assert.equal(result, "skip_shown_today");
});

test("maybeSendIntegrationNudge: returns skip_dismissed when dismissedAt < 48h ago", async () => {
  const dismissedAt = new Date(Date.now() - 10 * 60 * 60 * 1000); // 10h ago, within 48h gate
  const state = makeState({
    bizFindUnique: async () => ({ mpNudgeShownAt: null, mpNudgeDismissedAt: dismissedAt }),
  });
  const { sut } = loadSut("true", state);
  const result = await sut.maybeSendIntegrationNudge({ businessId: "biz-001", integration: "mp" });
  assert.equal(result, "skip_dismissed");
});

test("maybeSendIntegrationNudge: returns skip_connected when MP is already connected (TOCTOU fresh read)", async () => {
  const state = makeState({
    bizFindUnique: async () => ({ mpNudgeShownAt: null, mpNudgeDismissedAt: null }),
    mpFindUnique: async () => ({ id: "mp-cred-123" }), // connected
  });
  const { sut } = loadSut("true", state);
  const result = await sut.maybeSendIntegrationNudge({ businessId: "biz-001", integration: "mp" });
  assert.equal(result, "skip_connected");
});

test("maybeSendIntegrationNudge: returns sent and calls $transaction on happy path", async () => {
  const state = makeState({
    bizFindUnique: async () => ({ mpNudgeShownAt: null, mpNudgeDismissedAt: null }),
    mpFindUnique: async () => null, // not connected
  });
  const { sut } = loadSut("true", state);
  const result = await sut.maybeSendIntegrationNudge({ businessId: "biz-001", integration: "mp" });
  assert.equal(result, "sent");
  assert.equal(state.txCalls.length, 1, "$transaction must be called exactly once on happy path");
});

test("maybeSendIntegrationNudge: returns duplicate on P2002 from $transaction", async () => {
  const state = makeState({
    bizFindUnique: async () => ({ mpNudgeShownAt: null, mpNudgeDismissedAt: null }),
    mpFindUnique: async () => null,
  });
  const { sut, prisma } = loadSut("true", state);
  // Override $transaction to simulate P2002.
  prisma.$transaction = async () => {
    const err = new Error("Unique constraint failed");
    err.code = "P2002";
    throw err;
  };
  const result = await sut.maybeSendIntegrationNudge({ businessId: "biz-p2002", integration: "mp" });
  assert.equal(result, "duplicate");
});

test("maybeSendIntegrationNudge: returns internal_error (not skip_flag_off) on unexpected DB error in bizFindUnique", async () => {
  const state = makeState({
    bizFindUnique: async () => { throw new Error("Connection refused"); },
  });
  const { sut } = loadSut("true", state);
  let result;
  await assert.doesNotReject(
    async () => { result = await sut.maybeSendIntegrationNudge({ businessId: "biz-err", integration: "mp" }); },
    "must not throw on DB error",
  );
  assert.equal(result, "internal_error", "unexpected DB errors must return internal_error, not skip_flag_off");
});

test("maybeSendIntegrationNudge: dismiss gate passes (sent) when dismissedAt > 48h ago", async () => {
  const oldDismiss = new Date(Date.now() - 50 * 60 * 60 * 1000); // 50h ago — past gate
  const state = makeState({
    bizFindUnique: async () => ({ mpNudgeShownAt: null, mpNudgeDismissedAt: oldDismiss }),
    mpFindUnique: async () => null, // not connected → should proceed to send
  });
  const { sut } = loadSut("true", state);
  const result = await sut.maybeSendIntegrationNudge({ businessId: "biz-001", integration: "mp" });
  assert.equal(result, "sent", "dismiss gate must pass when >48h elapsed");
});
