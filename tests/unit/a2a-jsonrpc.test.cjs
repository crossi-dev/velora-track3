const assert = require("node:assert/strict");
const test = require("node:test");

const {
  handleA2ARpc,
  checkA2AApiKey,
  deriveA2AKey,
  extractTextFromParams,
  A2A_MAX_INPUT_CHARS,
} = require("../../src/app/api/a2a/jsonrpc/_lib/handle-rpc.ts");

const ECHO_SUPERVISOR = async (text) => `echoed: ${text}`;

const VALID_RPC = (method, params = {}, id = 1) => ({
  jsonrpc: "2.0",
  id,
  method,
  params,
});

const VALID_MESSAGE_PARAMS = {
  message: {
    kind: "message",
    messageId: "test-msg-id",
    role: "user",
    parts: [{ kind: "text", text: "hola" }],
  },
};

// ── handleA2ARpc — JSON-RPC framing ──────────────────────────────────

test("returns -32600 invalid request when jsonrpc version wrong", async () => {
  const res = await handleA2ARpc(
    { jsonrpc: "1.0", id: 1, method: "message/send", params: VALID_MESSAGE_PARAMS },
    ECHO_SUPERVISOR
  );
  assert.equal(res.error.code, -32600);
});

test("returns -32600 invalid request when method missing", async () => {
  const res = await handleA2ARpc({ jsonrpc: "2.0", id: 1, params: {} }, ECHO_SUPERVISOR);
  assert.equal(res.error.code, -32600);
});

test("returns -32601 method not found for unknown method", async () => {
  const res = await handleA2ARpc(VALID_RPC("unknown/method", {}), ECHO_SUPERVISOR);
  assert.equal(res.error.code, -32601);
});

// ── tasks/* compliance stubs ─────────────────────────────────────────

test("tasks/get returns -32001 task-not-found", async () => {
  const res = await handleA2ARpc(VALID_RPC("tasks/get", { id: "x" }), ECHO_SUPERVISOR);
  assert.equal(res.error.code, -32001);
});

test("tasks/cancel returns -32001 task-not-found", async () => {
  const res = await handleA2ARpc(VALID_RPC("tasks/cancel", { id: "x" }), ECHO_SUPERVISOR);
  assert.equal(res.error.code, -32001);
});

// ── message/send happy path ──────────────────────────────────────────

test("message/send invokes supervisor + returns Message reply", async () => {
  const res = await handleA2ARpc(VALID_RPC("message/send", VALID_MESSAGE_PARAMS), ECHO_SUPERVISOR);
  assert.equal(res.result.kind, "message");
  assert.equal(res.result.role, "agent");
  assert.equal(res.result.parts[0].kind, "text");
  assert.equal(res.result.parts[0].text, "echoed: hola");
  assert.ok(res.result.messageId);
  assert.ok(res.result.contextId);
});

test("message/send concatenates multiple text parts as supervisor input", async () => {
  let receivedText;
  const captureSupervisor = async (text) => {
    receivedText = text;
    return "ok";
  };
  await handleA2ARpc(
    VALID_RPC("message/send", {
      message: {
        kind: "message",
        messageId: "x",
        role: "user",
        parts: [
          { kind: "text", text: "linea 1" },
          { kind: "text", text: "linea 2" },
        ],
      },
    }),
    captureSupervisor
  );
  assert.equal(receivedText, "linea 1\nlinea 2");
});

// ── message/send param validation ────────────────────────────────────

test("message/send rejects when params.message missing", async () => {
  const res = await handleA2ARpc(VALID_RPC("message/send", {}), ECHO_SUPERVISOR);
  assert.equal(res.error.code, -32602);
});

test("message/send rejects when message.parts contains no text", async () => {
  const res = await handleA2ARpc(
    VALID_RPC("message/send", {
      message: { kind: "message", messageId: "x", role: "user", parts: [] },
    }),
    ECHO_SUPERVISOR
  );
  assert.equal(res.error.code, -32602);
});

test("message/send rejects non-text parts", async () => {
  const res = await handleA2ARpc(
    VALID_RPC("message/send", {
      message: {
        kind: "message",
        messageId: "x",
        role: "user",
        parts: [{ kind: "file", file: { uri: "x", mimeType: "image/png" } }],
      },
    }),
    ECHO_SUPERVISOR
  );
  assert.equal(res.error.code, -32602);
});

// ── Response framing ─────────────────────────────────────────────────

test("error responses preserve the request id", async () => {
  const res = await handleA2ARpc(VALID_RPC("unknown/method", {}, "req-abc-123"), ECHO_SUPERVISOR);
  assert.equal(res.id, "req-abc-123");
});

test("error responses always include jsonrpc: '2.0'", async () => {
  const res = await handleA2ARpc(VALID_RPC("unknown/method", {}), ECHO_SUPERVISOR);
  assert.equal(res.jsonrpc, "2.0");
});

test("result responses always include jsonrpc: '2.0'", async () => {
  const res = await handleA2ARpc(VALID_RPC("message/send", VALID_MESSAGE_PARAMS), ECHO_SUPERVISOR);
  assert.equal(res.jsonrpc, "2.0");
});

// ── checkA2AApiKey (HMAC per-tenant key derivation) ──────────────────
//
// Keys are derived: expected = HMAC-SHA256(A2A_SECRET, businessId).
// A valid key for tenant A cannot authenticate tenant B even with the same secret.

test("checkA2AApiKey: returns false when secret is undefined (env not set)", () => {
  assert.equal(checkA2AApiKey("any-key", undefined, "biz-1"), false);
});

test("checkA2AApiKey: returns false when provided is null", () => {
  assert.equal(checkA2AApiKey(null, "secret", "biz-1"), false);
});

test("checkA2AApiKey: returns false when businessId missing (no anonymous fallback)", () => {
  const key = deriveA2AKey("secret", "biz-1");
  assert.equal(checkA2AApiKey(key, "secret", null), false);
  assert.equal(checkA2AApiKey(key, "secret", undefined), false);
});

test("checkA2AApiKey: returns true on correctly-derived per-tenant key", () => {
  const key = deriveA2AKey("secret-1234", "biz-abc");
  assert.equal(checkA2AApiKey(key, "secret-1234", "biz-abc"), true);
});

test("checkA2AApiKey: returns false on tenant mismatch (key for biz-A, request for biz-B)", () => {
  const keyForA = deriveA2AKey("secret-1234", "biz-A");
  assert.equal(checkA2AApiKey(keyForA, "secret-1234", "biz-B"), false);
});

test("checkA2AApiKey: returns false on length mismatch (constant-time short-circuit)", () => {
  assert.equal(checkA2AApiKey("short", "secret", "biz-1"), false);
});

test("deriveA2AKey: deterministic — same inputs → same output", () => {
  const a = deriveA2AKey("secret", "biz-1");
  const b = deriveA2AKey("secret", "biz-1");
  assert.equal(a, b);
});

test("deriveA2AKey: different businessIds → different keys", () => {
  const a = deriveA2AKey("secret", "biz-1");
  const b = deriveA2AKey("secret", "biz-2");
  assert.notEqual(a, b);
});

// ── extractTextFromParams ────────────────────────────────────────────

test("extractTextFromParams: returns null on null/undefined params", () => {
  assert.equal(extractTextFromParams(null), null);
  assert.equal(extractTextFromParams(undefined), null);
});

test("extractTextFromParams: returns null when message missing", () => {
  assert.equal(extractTextFromParams({}), null);
});

test("extractTextFromParams: returns null when parts not array", () => {
  assert.equal(extractTextFromParams({ message: { parts: "string" } }), null);
});

test("extractTextFromParams: caps input at A2A_MAX_INPUT_CHARS (anti-DoS)", () => {
  const huge = "x".repeat(A2A_MAX_INPUT_CHARS * 3);
  const text = extractTextFromParams({
    message: { parts: [{ kind: "text", text: huge }] },
  });
  assert.equal(text.length, A2A_MAX_INPUT_CHARS);
});

test("extractTextFromParams: returns null when joined text is whitespace-only", () => {
  const text = extractTextFromParams({
    message: { parts: [{ kind: "text", text: "   \n  " }] },
  });
  assert.equal(text, null);
});

test("extractTextFromParams: ignores non-text parts gracefully", () => {
  const text = extractTextFromParams({
    message: {
      parts: [
        { kind: "file", file: { uri: "x", mimeType: "image/png" } },
        { kind: "text", text: "real text" },
        { kind: "data", data: { foo: "bar" } },
      ],
    },
  });
  assert.equal(text, "real text");
});
