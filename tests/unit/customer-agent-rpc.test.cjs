// Unit tests for handleCustomerRpcAsync (Customer Agent A2A JSON-RPC orchestrator).
//
// Tests JSON-RPC framing, header parsing, error handling, and graceful fallback
// when runCustomerAgent throws. runCustomerAgent is stubbed via setMockModule
// so no ADK/LLM calls are made.
//
// Pattern mirrors a2a-jsonrpc.test.cjs.

const assert = require("node:assert/strict");
const test = require("node:test");
const Module = require("node:module");
const path = require("node:path");

// ── Module hooks ──────────────────────────────────────────────────────────────

const { setMockModule, clearMockModules, resetSourceModules } = require("../phase4/module-hooks.cjs");

// ── SUT path ──────────────────────────────────────────────────────────────────

const HANDLE_RPC_PATH = path.resolve(
  __dirname,
  "../../src/app/api/agents/customer/jsonrpc/_lib/handle-customer-rpc.ts",
);

// Mutable stub — tests override per-call.
let mockRunCustomerAgent = async () => ({ text: "default reply" });

function installStubs() {
  clearMockModules();
  resetSourceModules();

  setMockModule("@/lib/cloud-logger", { cloudLog: () => {} });
  setMockModule("@/lib/adk/customer-agent", {
    runCustomerAgent: async (input) => mockRunCustomerAgent(input),
  });
  // a2a/jsonrpc-types is a pure data module with no side-effects — require directly.
}

function loadHandler() {
  delete Module._cache[HANDLE_RPC_PATH];
  return require(HANDLE_RPC_PATH);
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

function rpcRequest(method, params, id = "req-1") {
  return { jsonrpc: "2.0", id, method, params };
}

function textParams(text) {
  return {
    message: {
      kind: "message",
      messageId: "test-msg",
      role: "user",
      parts: [{ kind: "text", text }],
    },
  };
}

/** Complete valid A2A payload as the Supervisor constructs it. */
const SUPERVISOR_TEXT = (customerText = "quiero comprar un alfajor") =>
  `businessId: biz-001\ncustomerPhone: +5492612345678\n${customerText}`;

// ── JSON-RPC framing ──────────────────────────────────────────────────────────

test("returns -32600 when jsonrpc version is wrong", async () => {
  installStubs();
  const { handleCustomerRpcAsync } = loadHandler();
  const res = await handleCustomerRpcAsync(
    { jsonrpc: "1.0", id: 1, method: "message/send", params: textParams(SUPERVISOR_TEXT()) },
  );
  assert.equal(res.error.code, -32600);
});

test("returns -32600 when method is missing", async () => {
  installStubs();
  const { handleCustomerRpcAsync } = loadHandler();
  const res = await handleCustomerRpcAsync({ jsonrpc: "2.0", id: 1, params: {} });
  assert.equal(res.error.code, -32600);
});

test("returns -32601 for unknown method", async () => {
  installStubs();
  const { handleCustomerRpcAsync } = loadHandler();
  const res = await handleCustomerRpcAsync(rpcRequest("unknown/method", {}));
  assert.equal(res.error.code, -32601);
});

test("tasks/get returns -32001 task-not-found", async () => {
  installStubs();
  const { handleCustomerRpcAsync } = loadHandler();
  const res = await handleCustomerRpcAsync(rpcRequest("tasks/get", { id: "x" }));
  assert.equal(res.error.code, -32001);
});

test("tasks/cancel returns -32001 task-not-found", async () => {
  installStubs();
  const { handleCustomerRpcAsync } = loadHandler();
  const res = await handleCustomerRpcAsync(rpcRequest("tasks/cancel", { id: "x" }));
  assert.equal(res.error.code, -32001);
});

// ── Header extraction validation ──────────────────────────────────────────────

test("message/send: returns -32602 when businessId missing from payload", async () => {
  installStubs();
  const { handleCustomerRpcAsync } = loadHandler();
  // No businessId: header line
  const res = await handleCustomerRpcAsync(
    rpcRequest("message/send", textParams("customerPhone: +5492612345678\nhola")),
  );
  assert.equal(res.error.code, -32602);
  // Specific field name is in error.data (rpcError with 3rd-arg detail string)
  assert.match(res.error.data ?? res.error.message, /businessId/i);
});

test("message/send: returns -32602 when customerPhone missing from payload", async () => {
  installStubs();
  const { handleCustomerRpcAsync } = loadHandler();
  const res = await handleCustomerRpcAsync(
    rpcRequest("message/send", textParams("businessId: biz-001\nhola")),
  );
  assert.equal(res.error.code, -32602);
  assert.match(res.error.data ?? res.error.message, /customerPhone/i);
});

test("message/send: returns -32602 when customer message body is empty after header stripping", async () => {
  installStubs();
  const { handleCustomerRpcAsync } = loadHandler();
  // Headers only, no customer text
  const res = await handleCustomerRpcAsync(
    rpcRequest("message/send", textParams("businessId: biz-001\ncustomerPhone: +5492612345678")),
  );
  assert.equal(res.error.code, -32602);
});

test("message/send: extracts E.164 phone including leading + sign", async () => {
  installStubs();
  let capturedInput;
  mockRunCustomerAgent = async (input) => {
    capturedInput = input;
    return { text: "hola" };
  };
  const { handleCustomerRpcAsync } = loadHandler();
  await handleCustomerRpcAsync(
    rpcRequest("message/send", textParams(SUPERVISOR_TEXT("quiero un alfajor"))),
  );
  assert.equal(capturedInput.customerPhone, "+5492612345678");
});

test("message/send: extracts businessId from header line", async () => {
  installStubs();
  let capturedInput;
  mockRunCustomerAgent = async (input) => { capturedInput = input; return { text: "ok" }; };
  const { handleCustomerRpcAsync } = loadHandler();
  await handleCustomerRpcAsync(
    rpcRequest("message/send", textParams(SUPERVISOR_TEXT())),
  );
  assert.equal(capturedInput.businessId, "biz-001");
});

test("message/send: ctx.businessId overrides payload header (caller controls tenant)", async () => {
  installStubs();
  let capturedInput;
  mockRunCustomerAgent = async (input) => { capturedInput = input; return { text: "ok" }; };
  const { handleCustomerRpcAsync } = loadHandler();
  await handleCustomerRpcAsync(
    rpcRequest("message/send", textParams(SUPERVISOR_TEXT())),
    { businessId: "biz-from-ctx" },
  );
  assert.equal(capturedInput.businessId, "biz-from-ctx");
});

test("message/send: header lines are stripped from customer text sent to agent", async () => {
  installStubs();
  let capturedInput;
  mockRunCustomerAgent = async (input) => { capturedInput = input; return { text: "ok" }; };
  const { handleCustomerRpcAsync } = loadHandler();
  await handleCustomerRpcAsync(
    rpcRequest("message/send", textParams(SUPERVISOR_TEXT("quiero ver los precios"))),
  );
  // Agent must receive ONLY the customer message, not the envelope headers
  assert.ok(!capturedInput.text.includes("businessId:"), "businessId header must be stripped");
  assert.ok(!capturedInput.text.includes("customerPhone:"), "customerPhone header must be stripped");
  assert.ok(capturedInput.text.includes("quiero ver los precios"), "customer text must be present");
});

// ── Happy path ────────────────────────────────────────────────────────────────

test("message/send: returns A2A message envelope on success", async () => {
  installStubs();
  mockRunCustomerAgent = async () => ({ text: "Tenemos alfajores a $500 c/u." });
  const { handleCustomerRpcAsync } = loadHandler();
  const res = await handleCustomerRpcAsync(
    rpcRequest("message/send", textParams(SUPERVISOR_TEXT("¿qué precios tienen?"))),
  );
  assert.equal(res.jsonrpc, "2.0");
  assert.equal(res.result.kind, "message");
  assert.equal(res.result.role, "agent");
  assert.ok(Array.isArray(res.result.parts) && res.result.parts.length > 0);
  assert.equal(res.result.parts[0].kind, "text");
  assert.ok(res.result.parts[0].text.includes("alfajores"));
  assert.ok(res.result.messageId, "messageId must be present");
  assert.ok(res.result.contextId, "contextId must be present");
});

test("message/send: request id is preserved in success response", async () => {
  installStubs();
  mockRunCustomerAgent = async () => ({ text: "ok" });
  const { handleCustomerRpcAsync } = loadHandler();
  const res = await handleCustomerRpcAsync(
    rpcRequest("message/send", textParams(SUPERVISOR_TEXT()), "custom-id-xyz"),
  );
  assert.equal(res.id, "custom-id-xyz");
});

// ── Error handling (resilience) ───────────────────────────────────────────────

test("message/send: runCustomerAgent throw → returns graceful fallback text (no 500 propagation)", async () => {
  installStubs();
  mockRunCustomerAgent = async () => { throw new Error("ADK timeout"); };
  const { handleCustomerRpcAsync } = loadHandler();
  const res = await handleCustomerRpcAsync(
    rpcRequest("message/send", textParams(SUPERVISOR_TEXT())),
  );
  // Must NOT propagate as a JSON-RPC error — return a graceful text reply
  assert.ok(res.result, "must return a result envelope, not an error, when agent throws");
  assert.equal(res.result.kind, "message");
  assert.ok(res.result.parts[0].text.length > 0, "fallback text must be non-empty");
});

test("error responses preserve the request id", async () => {
  installStubs();
  const { handleCustomerRpcAsync } = loadHandler();
  const res = await handleCustomerRpcAsync(
    rpcRequest("unknown/method", {}, "my-req-99"),
  );
  assert.equal(res.id, "my-req-99");
});

test("error responses always include jsonrpc: '2.0'", async () => {
  installStubs();
  const { handleCustomerRpcAsync } = loadHandler();
  const res = await handleCustomerRpcAsync(rpcRequest("unknown/method", {}));
  assert.equal(res.jsonrpc, "2.0");
});

test("result responses always include jsonrpc: '2.0'", async () => {
  installStubs();
  mockRunCustomerAgent = async () => ({ text: "ok" });
  const { handleCustomerRpcAsync } = loadHandler();
  const res = await handleCustomerRpcAsync(
    rpcRequest("message/send", textParams(SUPERVISOR_TEXT())),
  );
  assert.equal(res.jsonrpc, "2.0");
});

// ── CUSTOMER_MAX_INPUT_CHARS export + enforcement ─────────────────────────────

test("CUSTOMER_MAX_INPUT_CHARS is exported and is a positive number", () => {
  installStubs();
  const { CUSTOMER_MAX_INPUT_CHARS } = loadHandler();
  assert.ok(typeof CUSTOMER_MAX_INPUT_CHARS === "number" && CUSTOMER_MAX_INPUT_CHARS > 0);
});

test("message/send: input longer than CUSTOMER_MAX_INPUT_CHARS is truncated before processing", async () => {
  installStubs();
  let capturedInput;
  mockRunCustomerAgent = async (input) => { capturedInput = input; return { text: "ok" }; };
  const { handleCustomerRpcAsync, CUSTOMER_MAX_INPUT_CHARS } = loadHandler();

  // Build a payload that exceeds the limit: headers (safe, small) + 5000-char body
  const overflowBody = "x".repeat(5000);
  // Total payload text: headers + body (well over CUSTOMER_MAX_INPUT_CHARS = 4000)
  const oversizeText =
    `businessId: biz-001\ncustomerPhone: +5492612345678\n${overflowBody}`;
  assert.ok(
    oversizeText.length > CUSTOMER_MAX_INPUT_CHARS,
    `Fixture must exceed limit (${oversizeText.length} <= ${CUSTOMER_MAX_INPUT_CHARS})`,
  );

  await handleCustomerRpcAsync(
    rpcRequest("message/send", textParams(oversizeText)),
  );

  // The text passed to the agent must come from the truncated rawText, so
  // the customer body portion should be shorter than the original 5000 chars.
  assert.ok(
    capturedInput !== undefined,
    "runCustomerAgent must have been called",
  );
  // capturedInput.text is the customer body after header stripping of the truncated payload.
  // Whatever is left of the body after truncation + stripping must be shorter than 5000.
  assert.ok(
    capturedInput.text.length < overflowBody.length,
    `Agent received ${capturedInput.text.length} chars — expected less than ${overflowBody.length} (truncation not applied)`,
  );
});
