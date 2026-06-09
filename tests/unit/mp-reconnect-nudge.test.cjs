"use strict";
// Tests for mp-reconnect-nudge.ts — proactive owner nudge when MP credentials fail.
// Uses Module._cache injection (same pattern as owner-push.test.cjs).

const assert = require("node:assert/strict");
const test = require("node:test");
const Module = require("node:module");
const path = require("node:path");

const { setMockModule, clearMockModules } = (() => {
  try { return require("../phase4/module-hooks.cjs"); }
  catch { return { setMockModule: () => {}, clearMockModules: () => {} }; }
})();

const SUT_PATH = path.resolve(__dirname, "../../src/app/api/agents/payments/jsonrpc/_lib/mp-reconnect-nudge.ts");
const CLOUD_LOGGER_PATH = path.resolve(__dirname, "../../src/lib/cloud-logger.ts");

// ── Mock state ────────────────────────────────────────────────────────────────

let mockChatMessage;
let mockFindFirst;

function makePrisma() {
  return {
    chatMessage: {
      findFirst: async (...args) => mockFindFirst(...args),
      create: async (...args) => mockChatMessage.create(...args),
    },
  };
}

function installMocks() {
  const prisma = makePrisma();
  setMockModule("@/lib/prisma", { prisma });
  setMockModule("@/lib/cloud-logger", { cloudLog: () => {} });

  const prismaPath = require.resolve("@/lib/prisma");
  Module._cache[prismaPath] = {
    id: prismaPath, filename: prismaPath, loaded: true,
    exports: { prisma },
  };
  Module._cache[CLOUD_LOGGER_PATH] = {
    id: CLOUD_LOGGER_PATH, filename: CLOUD_LOGGER_PATH, loaded: true,
    exports: { cloudLog: () => {} },
  };
}

function resetMocks() {
  delete Module._cache[SUT_PATH];
  const prismaPath = require.resolve("@/lib/prisma");
  delete Module._cache[prismaPath];
  delete Module._cache[CLOUD_LOGGER_PATH];
}

function loadSut() {
  resetMocks();
  installMocks();
  return require(SUT_PATH);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test("nudgeMpReconnect: writes ChatMessage when no prior nudge exists (reason=expired)", async () => {
  mockFindFirst = async () => null; // no recent nudge
  let created = null;
  mockChatMessage = {
    create: async (args) => { created = args; return {}; },
  };

  const { nudgeMpReconnect } = loadSut();
  await nudgeMpReconnect("biz-001", "expired");

  assert.ok(created, "chatMessage.create should have been called");
  assert.equal(created.data.businessId, "biz-001");
  assert.equal(created.data.kind, "reply");
  assert.equal(created.data.source, "manager");
  assert.equal(created.data.visibility, "owner_only");
  assert.match(created.data.text, /Mercado Pago/i);
});

test("nudgeMpReconnect: empty businessId is a no-op (no DB call)", async () => {
  let findCalled = false;
  mockFindFirst = async () => { findCalled = true; return null; };
  mockChatMessage = { create: async () => { throw new Error("should not be called"); } };

  const { nudgeMpReconnect } = loadSut();
  await nudgeMpReconnect("", "expired");

  assert.equal(findCalled, false, "findFirst must not be called for empty businessId");
});

test("nudgeMpReconnect: deduped within 30-min window — no second create", async () => {
  mockFindFirst = async () => ({ id: "msg-existing" }); // recent nudge found
  let createCalled = false;
  mockChatMessage = {
    create: async () => { createCalled = true; return {}; },
  };

  const { nudgeMpReconnect } = loadSut();
  await nudgeMpReconnect("biz-002", "expired");

  assert.equal(createCalled, false, "create must not be called when dedup row exists");
});

test("nudgeMpReconnect: different reason values produce different message text", async () => {
  const messages = {};

  for (const reason of ["expired", "not_connected", "decrypt_error"]) {
    mockFindFirst = async () => null;
    mockChatMessage = {
      create: async (args) => { messages[reason] = args.data.text; return {}; },
    };
    const { nudgeMpReconnect } = loadSut();
    await nudgeMpReconnect("biz-003", reason);
  }

  assert.notEqual(messages.expired, messages.not_connected, "expired vs not_connected must differ");
  assert.notEqual(messages.expired, messages.decrypt_error, "expired vs decrypt_error must differ");
  assert.notEqual(messages.not_connected, messages.decrypt_error, "not_connected vs decrypt_error must differ");
  assert.match(messages.expired, /venci[oó]/i);
  assert.match(messages.not_connected, /No te veo conectado/i);
  assert.match(messages.decrypt_error, /no se pudo leer/i);
});

test("nudgeMpReconnect: DB error in create is swallowed — does not throw", async () => {
  mockFindFirst = async () => null;
  mockChatMessage = {
    create: async () => { throw new Error("DB connection refused"); },
  };

  const { nudgeMpReconnect } = loadSut();
  // Should resolve without throwing
  await assert.doesNotReject(
    () => nudgeMpReconnect("biz-004", "expired"),
    "DB error must be swallowed — nudge is best-effort",
  );
});

test("nudgeMpReconnect: call after 30-min window elapses creates a new row", async () => {
  // Simulate a prior nudge created 31 minutes ago (outside the 30-min window).
  // The SUT filters by createdAt >= since (30 min ago), so a row 31 min old
  // should NOT be returned by findFirst → nudge fires again.
  mockFindFirst = async () => null; // 31 min old row would be outside window → findFirst returns null
  let createCalled = false;
  mockChatMessage = {
    create: async () => { createCalled = true; return {}; },
  };

  const { nudgeMpReconnect } = loadSut();
  await nudgeMpReconnect("biz-005", "expired");

  assert.equal(createCalled, true, "should create a new nudge after window elapsed");
});

test("nudgeMpReconnect: clientMessageId starts with mp-reconnect-nudge: prefix", async () => {
  mockFindFirst = async () => null;
  let created = null;
  mockChatMessage = {
    create: async (args) => { created = args; return {}; },
  };

  const { nudgeMpReconnect } = loadSut();
  await nudgeMpReconnect("biz-006", "not_connected");

  assert.ok(created.data.clientMessageId.startsWith("mp-reconnect-nudge:"), "clientMessageId must use the dedup prefix");
});
