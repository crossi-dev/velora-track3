"use strict";
// Tests for escalate-to-owner-tool.ts — FunctionTool that writes owner_only ChatMessage.
// Strategy: mock @google/adk's FunctionTool to capture the execute fn,
// then call execute() directly with controlled Prisma + owner-push mocks.

const assert = require("node:assert/strict");
const test = require("node:test");
const Module = require("node:module");
const path = require("node:path");

const { setMockModule, clearMockModules } = (() => {
  try { return require("../phase4/module-hooks.cjs"); }
  catch { return { setMockModule: () => {}, clearMockModules: () => {} }; }
})();

const SUT_PATH = path.resolve(__dirname, "../../src/lib/adk/tools/escalate-to-owner-tool.ts");
const CLOUD_LOGGER_PATH = path.resolve(__dirname, "../../src/lib/cloud-logger.ts");
const OWNER_PUSH_PATH = path.resolve(__dirname, "../../src/app/api/_lib/owner-push.ts");

// ── Mock state ────────────────────────────────────────────────────────────────

let capturedExecuteFn = null;
let mockPrismaCreate;
let mockSendPush;

function installMocks(prismaCreateFn) {
  // FunctionTool captures its config including execute during construction.
  // We intercept it so tests can call the execute fn directly.
  const adkPath = require.resolve("@google/adk");
  Module._cache[adkPath] = {
    id: adkPath, filename: adkPath, loaded: true,
    exports: {
      FunctionTool: class FakeFunctionTool {
        constructor(config) { capturedExecuteFn = config.execute; }
      },
      Type: { OBJECT: "OBJECT", STRING: "STRING" },
      // BaseSessionService / createEvent / BaseLlm: not used by this SUT, but
      // this stub replaces Module._cache["@google/adk"] for the rest of the
      // in-process run (restored only on process.exit, which doesn't fire
      // between files under tests/unit/run-all.cjs). Omitting them here
      // breaks `class VertexAgentEngineSessionService extends
      // BaseSessionService` (agent-engine-session-service.ts) and
      // `class VeloraEngineAdapter extends BaseLlm` (engine-adapter.ts) for
      // any test file that loads them after this one (same pattern as the
      // OAuth2Client stub gap).
      BaseSessionService: class {},
      createEvent: (e) => e,
      BaseLlm: class {},
    },
  };

  const genaiPath = require.resolve("@google/genai");
  Module._cache[genaiPath] = {
    id: genaiPath, filename: genaiPath, loaded: true,
    exports: { Type: { OBJECT: "OBJECT", STRING: "STRING" } },
  };

  const mockPrisma = {
    chatMessage: {
      create: async (...args) => (prismaCreateFn ?? mockPrismaCreate)(...args),
    },
  };
  setMockModule("@/lib/prisma", { prisma: mockPrisma });
  setMockModule("@/lib/cloud-logger", { cloudLog: () => {} });
  setMockModule("@/app/api/_lib/owner-push", {
    sendPushToOwner: async (...args) => (mockSendPush ?? (() => ({ attempted: 0, sent: 0, expired: 0, errors: [] })))(...args),
  });

  const prismaResolvedPath = require.resolve("@/lib/prisma");
  Module._cache[prismaResolvedPath] = {
    id: prismaResolvedPath, filename: prismaResolvedPath, loaded: true,
    exports: { prisma: mockPrisma },
  };
  Module._cache[CLOUD_LOGGER_PATH] = {
    id: CLOUD_LOGGER_PATH, filename: CLOUD_LOGGER_PATH, loaded: true,
    exports: { cloudLog: () => {} },
  };
  Module._cache[OWNER_PUSH_PATH] = {
    id: OWNER_PUSH_PATH, filename: OWNER_PUSH_PATH, loaded: true,
    exports: { sendPushToOwner: async (...args) => (mockSendPush ?? (() => ({})))(...args) },
  };
}

function resetSut() {
  delete Module._cache[SUT_PATH];
  capturedExecuteFn = null;
}

function loadAndBuildTool(ctx, prismaCreateFn) {
  resetSut();
  installMocks(prismaCreateFn);
  const { createEscalateToOwnerTool } = require(SUT_PATH);
  createEscalateToOwnerTool(ctx);
  return capturedExecuteFn;
}

function makeCtx(overrides = {}) {
  return {
    businessId: "biz-test",
    actorEmployeeId: "emp-001",
    actorName: "María López",
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test("execute: creates ChatMessage with correct fields on success", async () => {
  let created = null;
  const execute = loadAndBuildTool(makeCtx(), async (args) => { created = args; return {}; });

  const result = await execute({ reason: "cliente reclama producto defectuoso" });

  assert.ok(result.ok, "result.ok must be true");
  assert.ok(created, "chatMessage.create must be called");
  assert.equal(created.data.kind, "reply");
  assert.equal(created.data.source, "manager");
  assert.equal(created.data.visibility, "owner_only");
  assert.match(created.data.text, /cliente reclama producto defectuoso/);
  assert.equal(created.data.businessId, "biz-test");
});

test("execute: missing reason returns { ok: false, error: 'missing_reason' } without DB call", async () => {
  let createCalled = false;
  const execute = loadAndBuildTool(makeCtx(), async () => { createCalled = true; return {}; });

  const result = await execute({ reason: "" });

  assert.equal(result.ok, false);
  assert.equal(result.error, "missing_reason");
  assert.equal(createCalled, false, "DB must not be called for empty reason");
});

test("execute: urgency=high uses 🚨 URGENTE prefix in message text", async () => {
  let created = null;
  const execute = loadAndBuildTool(makeCtx(), async (args) => { created = args; return {}; });

  const result = await execute({ reason: "emergencia en caja", urgency: "high" });

  assert.ok(result.ok);
  assert.match(created.data.text, /🚨 URGENTE/);
  assert.equal(result.urgency, "high");
});

test("execute: urgency=high calls sendPushToOwner (fire-and-forget)", async () => {
  let pushCalled = false;
  mockSendPush = async () => { pushCalled = true; return { attempted: 1, sent: 1, expired: 0, errors: [] }; };

  const execute = loadAndBuildTool(makeCtx(), async () => ({}));

  await execute({ reason: "cliente furioso", urgency: "high" });
  // Push is void + fire-and-forget, give the microtask queue a tick to settle.
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(pushCalled, true, "sendPushToOwner must be called");
  mockSendPush = null;
});

test("execute: very long reason is truncated to 280 chars in persisted text", async () => {
  let created = null;
  const execute = loadAndBuildTool(makeCtx(), async (args) => { created = args; return {}; });

  const longReason = "x".repeat(400);
  await execute({ reason: longReason });

  // The text is: "<prefix> · <actorName>: "<reason (truncated to 280)>""
  // Reason is sliced at 280 before building alertText.
  assert.ok(created.data.text.includes("x".repeat(280)), "truncated reason (280 chars) must appear");
  assert.ok(!created.data.text.includes("x".repeat(281)), "reason must not exceed 280 chars");
});

test("execute: actorName=null falls back to 'El empleado' in message", async () => {
  let created = null;
  const ctx = makeCtx({ actorName: null });
  const execute = loadAndBuildTool(ctx, async (args) => { created = args; return {}; });

  await execute({ reason: "situación límite" });

  assert.match(created.data.text, /El empleado/);
});

test("execute: prisma.chatMessage.create failure returns { ok: false, error: 'write_failed' } without throwing", async () => {
  const execute = loadAndBuildTool(makeCtx(), async () => {
    throw new Error("DB write failed");
  });

  const result = await execute({ reason: "algo importante" });

  assert.equal(result.ok, false);
  assert.equal(result.error, "write_failed");
  assert.ok(result.answer, "answer must still be present even on failure");
});

test("execute: returns { ok: true, urgency, answer } shape on success", async () => {
  const execute = loadAndBuildTool(makeCtx(), async () => ({}));

  const result = await execute({ reason: "duda en el precio" });

  assert.equal(result.ok, true);
  assert.ok(["low", "medium", "high"].includes(result.urgency), "urgency must be one of low/medium/high");
  assert.ok(typeof result.answer === "string" && result.answer.length > 0, "answer must be a non-empty string");
});

test("execute: answer text quotes the reason to the employee", async () => {
  const execute = loadAndBuildTool(makeCtx(), async () => ({}));

  const result = await execute({ reason: "devolución de producto" });

  assert.match(result.answer, /devolución de producto/, "answer must echo the reason back");
});

test("execute: default urgency is 'medium' when not provided", async () => {
  let created = null;
  const execute = loadAndBuildTool(makeCtx(), async (args) => { created = args; return {}; });

  const result = await execute({ reason: "aviso general" });

  assert.equal(result.urgency, "medium");
  assert.match(created.data.text, /⚠️ Aviso/);
});

test("execute: urgency=low uses ℹ️ Para tu info prefix", async () => {
  let created = null;
  const execute = loadAndBuildTool(makeCtx(), async (args) => { created = args; return {}; });

  await execute({ reason: "nota de color", urgency: "low" });

  assert.match(created.data.text, /ℹ️ Para tu info/);
});
