// Unit tests for customer-dispatch.ts
//
// Tests:
//   1. Successful dispatch → returns replyText from Customer Agent
//   2. Customer Agent returns empty reply → replyText is null
//   3. a2a-client throws A2AClientError → propagates (caller must catch)
//   4. A2A_SECRET set → deriveA2AKey called (X-API-Key derived)
//   5. A2A_SECRET not set → dispatch proceeds without apiKey (degraded mode)
//   6. messageId used as contextId prefix (idempotency anchor)
//
// sendMessage, signAgentAssertion, deriveA2AKey, and cloudLog are all mocked.

"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const Module = require("node:module");
const path = require("node:path");

const { setMockModule, clearMockModules, resetSourceModules } = require("../phase4/module-hooks.cjs");

const SUT_PATH = path.resolve(
  __dirname,
  "../../src/app/api/whatsapp/_lib/customer-dispatch.ts",
);

// ── Helpers ────────────────────────────────────────────────────────────────────

let capturedSendArgs = null;
let logCalls = [];
let mockSendImpl = async () => ({ messageId: "m1", text: "hola!", dataParts: [], contextId: "ctx-1" });

function installMocks() {
  logCalls = [];
  capturedSendArgs = null;
  clearMockModules();
  resetSourceModules();

  setMockModule("@/lib/cloud-logger", {
    cloudLog: (entry) => { logCalls.push(entry); },
  });

  setMockModule("@/lib/a2a-client", {
    sendMessage: async (url, text, opts) => {
      capturedSendArgs = { url, text, opts };
      return mockSendImpl(url, text, opts);
    },
    A2AClientError: class A2AClientError extends Error {
      constructor(msg, code, cause) {
        super(msg);
        this.name = "A2AClientError";
        this.code = code;
        this.cause = cause;
      }
    },
  });

  setMockModule("@/lib/agent-identity", {
    signAgentAssertion: (_iss, _aud) => "mock-jwt-token",
  });

  // Mock deriveA2AKey — used to generate X-API-Key from A2A_SECRET + businessId
  setMockModule("@/app/api/a2a/jsonrpc/_lib/handle-rpc", {
    deriveA2AKey: (_secret, businessId) => `derived-key-for-${businessId}`,
  });

  setMockModule("@/lib/agent-timeouts", {
    COMMUNICATIONS_AGENT_TIMEOUT_MS: 15_000,
  });
}

function loadSut() {
  delete Module._cache[SUT_PATH];
  return require(SUT_PATH);
}

// ── Tests ──────────────────────────────────────────────────────────────────────

test("Successful dispatch → returns replyText from Customer Agent", async () => {
  mockSendImpl = async () => ({
    messageId: "msg-1",
    text: "¡Hola! ¿En qué te puedo ayudar?",
    dataParts: [],
    contextId: "ctx-1",
  });
  installMocks();
  const { dispatchInboundToCustomerAgent } = loadSut();

  const result = await dispatchInboundToCustomerAgent({
    businessId: "biz-test-123456789012345",
    customerPhone: "+5490000000000",
    text: "Quiero saber el precio del aceite",
    messageId: "wamid.abc123",
  });

  assert.equal(result.replyText, "¡Hola! ¿En qué te puedo ayudar?");
});

test("Customer Agent returns empty reply → replyText is null", async () => {
  mockSendImpl = async () => ({
    messageId: "msg-2",
    text: "",
    dataParts: [],
    contextId: "ctx-2",
  });
  installMocks();
  const { dispatchInboundToCustomerAgent } = loadSut();

  const result = await dispatchInboundToCustomerAgent({
    businessId: "biz-test-123456789012345",
    customerPhone: "+5490000000000",
    text: "hola",
    messageId: "wamid.empty1",
  });

  assert.equal(result.replyText, null);
});

test("A2A_SECRET set → apiKey is derived and passed to sendMessage", async () => {
  mockSendImpl = async () => ({ messageId: "m3", text: "ok", dataParts: [], contextId: "c3" });
  installMocks();
  process.env.A2A_SECRET = "test-secret";
  try {
    const { dispatchInboundToCustomerAgent } = loadSut();

    await dispatchInboundToCustomerAgent({
      businessId: "biz-test-123456789012345",
      customerPhone: "+5490000000000",
      text: "consulta",
      messageId: "wamid.key1",
    });

    assert.equal(capturedSendArgs.opts.apiKey, "derived-key-for-biz-test-123456789012345");
  } finally {
    delete process.env.A2A_SECRET;
  }
});

test("A2A_SECRET not set → apiKey is undefined (degraded mode)", async () => {
  mockSendImpl = async () => ({ messageId: "m4", text: "ok", dataParts: [], contextId: "c4" });
  installMocks();
  delete process.env.A2A_SECRET;
  const { dispatchInboundToCustomerAgent } = loadSut();

  await dispatchInboundToCustomerAgent({
    businessId: "biz-test-123456789012345",
    customerPhone: "+5490000000000",
    text: "consulta",
    messageId: "wamid.nokey1",
  });

  assert.equal(capturedSendArgs.opts.apiKey, undefined);
});

test("messageId used as contextId prefix for idempotency", async () => {
  mockSendImpl = async () => ({ messageId: "m5", text: "ok", dataParts: [], contextId: "c5" });
  installMocks();
  const { dispatchInboundToCustomerAgent } = loadSut();

  await dispatchInboundToCustomerAgent({
    businessId: "biz-test-123456789012345",
    customerPhone: "+5490000000000",
    text: "test idempotency",
    messageId: "wamid.idempotent999",
  });

  assert.equal(capturedSendArgs.opts.contextId, "whatsapp-inbound-wamid.idempotent999");
});

test("A2A payload embeds businessId + customerPhone as header lines", async () => {
  mockSendImpl = async () => ({ messageId: "m6", text: "ok", dataParts: [], contextId: "c6" });
  installMocks();
  const { dispatchInboundToCustomerAgent } = loadSut();

  await dispatchInboundToCustomerAgent({
    businessId: "biz-abc123456789012345",
    customerPhone: "+5491122334455",
    text: "consulta de precio",
    messageId: "wamid.hdr1",
  });

  const { text } = capturedSendArgs;
  assert.ok(text.startsWith("businessId: biz-abc123456789012345\n"), "businessId header missing");
  assert.ok(text.includes("customerPhone: +5491122334455\n"), "customerPhone header missing");
  assert.ok(text.includes("consulta de precio"), "message text missing");
});

test("sendMessage throws → error propagates (caller must catch)", async () => {
  const { A2AClientError: MockA2AClientError } = require("../phase4/module-hooks.cjs")
    ? { A2AClientError: class MockErr extends Error { constructor(m, c) { super(m); this.code = c; } } }
    : { A2AClientError: Error };

  installMocks();
  // Override sendMessage to throw
  setMockModule("@/lib/a2a-client", {
    sendMessage: async () => { throw new Error("Network timeout"); },
    A2AClientError: MockA2AClientError,
  });
  const { dispatchInboundToCustomerAgent } = loadSut();

  await assert.rejects(
    () =>
      dispatchInboundToCustomerAgent({
        businessId: "biz-test-123456789012345",
        customerPhone: "+5490000000000",
        text: "test",
        messageId: "wamid.throw1",
      }),
    /Network timeout/,
  );
});
