"use strict";

// Unit tests for the Fiscal Agent RPC handler + helpers.
//
// Covers:
//   1. extractBusinessIdFromText — parses the "businessId: <id>" header line.
//   2. handleFiscalRpc — invalid JSON-RPC framing returns -32600.
//   3. handleFiscalRpc — message/send with no text returns -32602.
//   4. handleFiscalRpc — message/send dispatches to ADK + returns message reply.
//   5. handleFiscalRpc — sandbox-comprobante: sandboxUsed flag triggers prefix.
//   6. handleFiscalRpc — tasks/get returns -32001.
//   7. handleFiscalRpc — unknown method returns -32601.
//   8. handleFiscalRpc — ADK runner throws → returns error text gracefully.

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  clearMockModules,
  resetSourceModules,
  setMockModule,
} = require("../phase4/module-hooks.cjs");

// ── Fixtures ──────────────────────────────────────────────────────────────────

const VALID_TEXT_PARAMS = {
  message: {
    kind: "message",
    messageId: "test-msg",
    role: "user",
    parts: [{ kind: "text", text: "Validá el CUIT 20-12345678-9" }],
  },
};

const VALID_RPC = (method, params = {}, id = 1) => ({
  jsonrpc: "2.0",
  id,
  method,
  params,
});

// ── Loader ────────────────────────────────────────────────────────────────────

/**
 * Loads handle-fiscal-rpc.ts with controlled mocks.
 *
 * The import chain:
 *   handle-fiscal-rpc.ts
 *     → @/lib/a2a/jsonrpc-types   (pure, no heavy deps)
 *     → @/lib/cloud-logger        (stubbed)
 *     → @google/adk               (stubbed)
 *     → ./fiscal-agent            (stubbed — prevents @google/adk + emit-invoice-tool load)
 *     → ./emit-invoice-tool       (NOT reached because ./fiscal-agent is stubbed)
 *
 * The key for a relative import "./fiscal-agent" inside handle-fiscal-rpc.ts is
 * exactly "./fiscal-agent" because Node._load receives the original request string.
 */
function loadHandler({ adkReply = "CUIT válido.", sandboxUsed = false, adkThrows = false } = {}) {
  resetSourceModules();
  clearMockModules();

  // Stub cloud-logger — no GCP credentials needed in tests.
  setMockModule("@/lib/cloud-logger", { cloudLog: () => {} });

  // Stub @/lib/prisma transitively required by emit-invoice-tool.
  // Even though ./fiscal-agent is stubbed below, some environments cache the
  // real module from prior test files; stubbing prisma keeps the env guard out.
  setMockModule("@/lib/prisma", {
    prisma: {
      arcaCredential: { findFirst: async () => null },
      business: { findUnique: async () => null },
    },
  });

  // Stub the fiscal-agent module so no real ADK/Gemini connection is made.
  // The key must match the exact request string that handle-fiscal-rpc.ts uses:
  // import { createFiscalAgent } from "./fiscal-agent"
  const fakeAgent = { _fake: true };
  setMockModule("./fiscal-agent", {
    createFiscalAgent: (_ctx, _profile, toolCtx) => {
      // Simulate sandbox usage when requested.
      if (sandboxUsed) toolCtx.sandboxUsed = true;
      return fakeAgent;
    },
  });

  // Also stub emit-invoice-tool in case any cached path bypasses ./fiscal-agent.
  setMockModule("./emit-invoice-tool", {
    buildEmitInvoiceTool: () => ({}),
  });

  // Stub @google/adk so tests never touch the real ADK runtime.
  setMockModule("@google/adk", {
    InMemoryRunner: class {
      constructor() {}
      runEphemeral() {
        if (adkThrows) {
          return (async function* () {
            throw new Error("ADK boom");
          })();
        }
        // Emit a single final-response event with the configured reply text.
        return (async function* () {
          yield {
            _isFinalResponse: true,
            content: {
              parts: [{ text: adkReply }],
            },
          };
        })();
      }
    },
    isFinalResponse: (event) => Boolean(event._isFinalResponse),
    // Required by handle-fiscal-rpc.ts FIX 2 — returns function-response parts from an event.
    // Returns empty array for test events (no emit_invoice tool calls in these tests).
    getFunctionResponses: () => [],
  });

  return require(
    "../../src/app/api/agents/fiscal/jsonrpc/_lib/handle-fiscal-rpc.ts",
  );
}

// ── 1. extractBusinessIdFromText ──────────────────────────────────────────────

test("extractBusinessIdFromText — parses standard header line", () => {
  const { extractBusinessIdFromText } = loadHandler();
  const result = extractBusinessIdFromText("businessId: abc123def456ghi789jkl\nHola");
  assert.equal(result, "abc123def456ghi789jkl");
});

test("extractBusinessIdFromText — returns null when line absent", () => {
  const { extractBusinessIdFromText } = loadHandler();
  assert.equal(extractBusinessIdFromText("Validá el CUIT 20-12345678-9"), null);
});

test("extractBusinessIdFromText — returns null on empty string", () => {
  const { extractBusinessIdFromText } = loadHandler();
  assert.equal(extractBusinessIdFromText(""), null);
});

test("extractBusinessIdFromText — stops at first whitespace after id token", () => {
  const { extractBusinessIdFromText } = loadHandler();
  // LLM may add prose after the id — must NOT include it in the token.
  const result = extractBusinessIdFromText("businessId: abc123 some extra prose\nmore");
  assert.equal(result, "abc123");
});

// ── 2. Invalid JSON-RPC framing ───────────────────────────────────────────────

test("handleFiscalRpc — wrong jsonrpc version returns -32600", async () => {
  const { handleFiscalRpc } = loadHandler();
  const res = await handleFiscalRpc({ jsonrpc: "1.0", id: 1, method: "message/send" });
  assert.equal(res.error.code, -32600);
});

test("handleFiscalRpc — missing method returns -32600", async () => {
  const { handleFiscalRpc } = loadHandler();
  const res = await handleFiscalRpc({ jsonrpc: "2.0", id: 1 });
  assert.equal(res.error.code, -32600);
});

// ── 3. message/send — no text ─────────────────────────────────────────────────

test("handleFiscalRpc — message/send with no text parts returns -32602", async () => {
  const { handleFiscalRpc } = loadHandler();
  const res = await handleFiscalRpc(
    VALID_RPC("message/send", { message: { parts: [] } }),
  );
  assert.equal(res.error.code, -32602);
});

test("handleFiscalRpc — message/send with missing params returns -32602", async () => {
  const { handleFiscalRpc } = loadHandler();
  const res = await handleFiscalRpc(VALID_RPC("message/send", {}));
  assert.equal(res.error.code, -32602);
});

// ── 4. message/send happy path ────────────────────────────────────────────────

test("handleFiscalRpc — message/send returns message result with ADK reply", async () => {
  const { handleFiscalRpc } = loadHandler({ adkReply: "CUIT 20-12345678-9 válido." });
  const res = await handleFiscalRpc(VALID_RPC("message/send", VALID_TEXT_PARAMS));

  assert.ok(res.result, "should have result");
  assert.equal(res.result.kind, "message");
  assert.equal(res.result.role, "agent");
  assert.ok(Array.isArray(res.result.parts));
  assert.equal(res.result.parts[0].kind, "text");
  assert.equal(res.result.parts[0].text, "CUIT 20-12345678-9 válido.");
  assert.ok(res.result.messageId);
  assert.ok(res.result.contextId);
  assert.equal(res.jsonrpc, "2.0");
});

test("handleFiscalRpc — response id matches request id", async () => {
  const { handleFiscalRpc } = loadHandler();
  const res = await handleFiscalRpc(VALID_RPC("message/send", VALID_TEXT_PARAMS, "req-xyz"));
  assert.equal(res.id, "req-xyz");
});

// ── 5. Sandbox-comprobante path ───────────────────────────────────────────────
// FIX (2026-05-27): sandbox status is no longer prepended to replyText.
// handle-fiscal-rpc.ts FIX 1 removed the "⚠️ Comprobante de SANDBOX" prefix
// from replyText and replaced it with a structured dataPart ({ sandboxUsed: true }).
// containsOwnerContent() was matching "SANDBOX" and silently suppressing 100% of
// fiscal receipts (ARCA_REAL_MODE=false is the default) — customer never got PDF.
// Canonical 2026: metadata travels in dataParts, not in customer-facing text.
// Source: https://docs.stripe.com/sandboxes (sandbox markers in metadata, not body)

test("handleFiscalRpc — sandbox mode: replyText is NOT prefixed, dataPart carries sandboxUsed flag", async () => {
  const { handleFiscalRpc } = loadHandler({
    adkReply: "Factura B emitida.",
    sandboxUsed: true,
  });
  const res = await handleFiscalRpc(VALID_RPC("message/send", VALID_TEXT_PARAMS));

  assert.ok(res.result);
  const text = res.result.parts[0].text;
  // Text must NOT have the legacy sandbox prefix (it suppressed customer PDFs).
  assert.ok(
    !text.startsWith("⚠️ Comprobante de SANDBOX"),
    `replyText must not carry sandbox prefix — got: ${text.slice(0, 80)}`,
  );
  assert.ok(
    text.includes("Factura B emitida."),
    "original ADK reply must be preserved verbatim",
  );
  // sandboxUsed must travel as a structured dataPart instead.
  const dataPart = res.result.parts.find(
    (p) => p.kind === "data" && p.data?.sandboxUsed === true,
  );
  assert.ok(dataPart, "dataPart with sandboxUsed=true must be present");
});

// ── 6. tasks/get ─────────────────────────────────────────────────────────────

test("handleFiscalRpc — tasks/get returns -32001", async () => {
  const { handleFiscalRpc } = loadHandler();
  const res = await handleFiscalRpc(VALID_RPC("tasks/get", { id: "t1" }));
  assert.equal(res.error.code, -32001);
});

test("handleFiscalRpc — tasks/cancel returns -32001", async () => {
  const { handleFiscalRpc } = loadHandler();
  const res = await handleFiscalRpc(VALID_RPC("tasks/cancel", { id: "t1" }));
  assert.equal(res.error.code, -32001);
});

// ── 7. Unknown method ────────────────────────────────────────────────────────

test("handleFiscalRpc — unknown method returns -32601", async () => {
  const { handleFiscalRpc } = loadHandler();
  const res = await handleFiscalRpc(VALID_RPC("unknown/method"));
  assert.equal(res.error.code, -32601);
});

// ── 8. ADK runner throws ─────────────────────────────────────────────────────

test("handleFiscalRpc — ADK runner throws → returns graceful error text", async () => {
  const { handleFiscalRpc } = loadHandler({ adkThrows: true });
  const res = await handleFiscalRpc(VALID_RPC("message/send", VALID_TEXT_PARAMS));

  // Must return a result (not an RPC error) with a Spanish error string.
  assert.ok(res.result, "should have result even on ADK failure");
  const text = res.result.parts[0].text;
  assert.ok(
    text.includes("Error interno del Fiscal Agent"),
    `expected fallback error text, got: ${text}`,
  );
});
