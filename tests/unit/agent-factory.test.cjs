// Tests for src/lib/adk/agent-factory.ts
//
// Covers:
//   1. beforeToolCallback is wired and calls cloudLog on tool start.
//   2. afterToolCallback is wired and calls cloudLog on tool end.
//   3. afterToolCallback logs WARNING when response contains "error" key.
//   4. Neither callback mutates the tool result (pass-through contract).
//   5. Callbacks are overridable via options.
//   6. No PII in arg summary — summariseArgs returns types, not values.

const assert = require("node:assert/strict");
const test = require("node:test");
const Module = require("node:module");
const path = require("node:path");

const SUT_PATH = path.resolve(__dirname, "../../src/lib/adk/agent-factory.ts");

// ── Stubs ─────────────────────────────────────────────────────────────────────

// Captured cloudLog calls for assertions.
let logCalls = [];

const origLoad = Module._load;
Module._load = function (request, parent, ...rest) {
  // Intercept @/lib/cloud-logger — capture calls instead of no-op
  if (request === "@/lib/cloud-logger") {
    return {
      cloudLog: (entry) => { logCalls.push(entry); },
    };
  }
  // Intercept server-only
  if (request === "server-only") return {};
  return origLoad.call(this, request, parent, ...rest);
};

// Intercept @google/adk — FakeAgent captures config passed to constructor
let lastAgentConfig = null;
const adkPath = require.resolve("@google/adk");
Module._cache[adkPath] = {
  id: adkPath,
  filename: adkPath,
  loaded: true,
  exports: {
    Agent: class FakeAgent {
      constructor(config) { lastAgentConfig = config; }
    },
    // Types — not used at runtime by agent-factory but present for ts-node
    BaseTool: class FakeBaseTool {},
    // Base class extended by src/lib/adk/engine-adapter.ts (VeloraEngineAdapter).
    // This mock stays cached on Module._cache after this file loads (never
    // restored), so any later require of engine-adapter.ts still needs a real
    // constructor here or `class ... extends BaseLlm` throws at load time.
    BaseLlm: class FakeBaseLlm {},
    Gemini: class FakeGemini {},
    // Exports referenced by other modules loaded transitively
    InMemorySessionService: class {},
    BaseSessionService: class {},
    createEvent: (e) => e,
    isFinalResponse: () => true,
    getFunctionCalls: () => [],
    getFunctionResponses: () => [],
    InMemoryRunner: class {},
    Runner: class {},
    BaseToolset: class {},
  },
};

process.on("exit", () => {
  Module._load = origLoad;
});

function reload() {
  delete Module._cache[SUT_PATH];
  logCalls = [];
  lastAgentConfig = null;
  return require(SUT_PATH);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeFakeTool(name) {
  return { name, description: `${name} tool` };
}

function makeCtx() {
  return {};
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test("createAdkAgent: wires beforeToolCallback that logs TOOL_CALL_START", () => {
  const { createAdkAgent } = reload();
  createAdkAgent({
    name: "test_agent",
    model: {},
    instruction: "Be helpful.",
    tools: [],
  });

  assert.ok(lastAgentConfig, "Agent constructor was called");
  assert.equal(typeof lastAgentConfig.beforeToolCallback, "function");

  // Invoke the callback as ADK would — no return value expected
  const tool = makeFakeTool("register_sale");
  const args = { productId: "abc123", qty: 2, phone: "+5491155550000" };
  const result = lastAgentConfig.beforeToolCallback({ tool, args, context: makeCtx() });

  // Pass-through contract: must return undefined (not a Record)
  assert.equal(result, undefined, "beforeToolCallback must be a pass-through (return undefined)");

  // Must have logged exactly one TOOL_CALL_START entry
  const entry = logCalls.find((e) => e.action === "TOOL_CALL_START");
  assert.ok(entry, "cloudLog called with TOOL_CALL_START");
  assert.equal(entry.data.tool, "register_sale");

  // PII check: arg VALUES must not appear in log — only types
  const argShape = entry.data.argShape;
  assert.equal(argShape.productId, "string", "arg type logged, not value");
  assert.equal(argShape.qty, "number");
  assert.equal(argShape.phone, "string");
  // Actual values must NOT be logged
  assert.ok(!JSON.stringify(argShape).includes("+5491155550000"), "phone value not logged");
  assert.ok(!JSON.stringify(argShape).includes("abc123"), "productId value not logged");
});

test("createAdkAgent: wires afterToolCallback that logs TOOL_CALL_END on success", () => {
  const { createAdkAgent } = reload();
  createAdkAgent({
    name: "test_agent",
    model: {},
    instruction: "Be helpful.",
    tools: [],
  });

  assert.equal(typeof lastAgentConfig.afterToolCallback, "function");

  const tool = makeFakeTool("get_stock");
  const args = { sku: "SKU-001" };
  const response = { stock: 42, productName: "Widget" };

  const result = lastAgentConfig.afterToolCallback({
    tool,
    args,
    context: makeCtx(),
    response,
  });

  // Pass-through contract: must return undefined
  assert.equal(result, undefined, "afterToolCallback must be a pass-through (return undefined)");

  const entry = logCalls.find((e) => e.action === "TOOL_CALL_END");
  assert.ok(entry, "cloudLog called with TOOL_CALL_END on success");
  assert.equal(entry.severity, "DEBUG");
  assert.equal(entry.data.tool, "get_stock");

  // PII check: response values must not appear; only responseKeys (names) are logged
  assert.ok(!JSON.stringify(entry.data).includes("Widget"), "response values not logged");
});

test("createAdkAgent: afterToolCallback logs WARNING when response has error key", () => {
  const { createAdkAgent } = reload();
  createAdkAgent({
    name: "test_agent",
    model: {},
    instruction: "Be helpful.",
    tools: [],
  });

  const tool = makeFakeTool("create_payment_link");
  const args = { amount: 1000 };
  const response = { error: "MP_TIMEOUT: upstream timed out" };

  const result = lastAgentConfig.afterToolCallback({
    tool,
    args,
    context: makeCtx(),
    response,
  });

  // Pass-through contract: must return undefined even on error
  assert.equal(result, undefined, "afterToolCallback must be pass-through on error too");

  const errorEntry = logCalls.find((e) => e.action === "TOOL_CALL_ERROR");
  assert.ok(errorEntry, "cloudLog called with TOOL_CALL_ERROR on tool error");
  assert.equal(errorEntry.severity, "WARNING");
  assert.equal(errorEntry.data.tool, "create_payment_link");
  assert.ok(errorEntry.data.error.includes("MP_TIMEOUT"), "error string included in log data");
});

test("createAdkAgent: afterToolCallback does NOT log WARNING for null-sentinel error field", () => {
  // RPC-style responses often include { result: "ok", error: null } as a null
  // sentinel. The hasError check must be falsy for these — checking key presence
  // alone would produce spurious WARNING logs on every successful tool call.
  const { createAdkAgent } = reload();
  createAdkAgent({ name: "test_agent", model: {}, instruction: "Be helpful." });

  const tool = makeFakeTool("quote_shipping");
  const args = { weight: 1.5 };
  const response = { price: 350, error: null }; // null-sentinel pattern

  const result = lastAgentConfig.afterToolCallback({
    tool, args, context: makeCtx(), response,
  });

  assert.equal(result, undefined);

  // Must log TOOL_CALL_END (success), NOT TOOL_CALL_ERROR
  const endEntry = logCalls.find((e) => e.action === "TOOL_CALL_END");
  const errorEntry = logCalls.find((e) => e.action === "TOOL_CALL_ERROR");
  assert.ok(endEntry, "TOOL_CALL_END logged for null-sentinel error field");
  assert.equal(errorEntry, undefined, "No TOOL_CALL_ERROR when error is null");
});

test("summariseArgs: null value branch produces 'null' type string", () => {
  // Exercises the null branch (val === null → "null") in summariseArgs.
  // Covered via the callback test to avoid exposing the private function.
  const { createAdkAgent } = reload();
  createAdkAgent({ name: "test_agent", model: {}, instruction: "p." });

  const tool = makeFakeTool("some_tool");
  const args = { nullField: null, arrField: [1, 2, 3], strField: "hello" };

  lastAgentConfig.beforeToolCallback({ tool, args, context: makeCtx() });

  const entry = logCalls.find((e) => e.action === "TOOL_CALL_START");
  assert.ok(entry);
  assert.equal(entry.data.argShape.nullField, "null", "null value → 'null' string");
  assert.equal(entry.data.argShape.arrField, "array(3)", "array value → 'array(N)'");
  assert.equal(entry.data.argShape.strField, "string");
});

test("createAdkAgent: callbacks are overridable per agent", () => {
  const { createAdkAgent } = reload();

  let customBeforeCalled = false;
  const customBefore = () => { customBeforeCalled = true; return undefined; };

  createAdkAgent({
    name: "custom_agent",
    model: {},
    instruction: "Custom.",
    tools: [],
    beforeToolCallback: customBefore,
  });

  assert.equal(lastAgentConfig.beforeToolCallback, customBefore,
    "custom beforeToolCallback passed through to Agent constructor");

  // Invoke to confirm it runs and the built-in observer was NOT wired
  lastAgentConfig.beforeToolCallback({ tool: makeFakeTool("foo"), args: {}, context: makeCtx() });
  assert.ok(customBeforeCalled, "custom callback was invoked");

  // Built-in observer would have logged; custom one does not — verify logCalls is empty
  const startEntry = logCalls.find((e) => e.action === "TOOL_CALL_START");
  assert.equal(startEntry, undefined, "custom callback does not log (override replaces default)");
});

test("createAdkAgent: instruction wrapped as callback regardless of type", () => {
  const { createAdkAgent } = reload();

  createAdkAgent({
    name: "instr_agent",
    model: {},
    instruction: "A plain string instruction.",
    tools: [],
  });

  assert.equal(typeof lastAgentConfig.instruction, "function",
    "string instruction wrapped as callback");
  assert.equal(lastAgentConfig.instruction(), "A plain string instruction.");
});

test("createAdkAgent: function instruction left as-is", () => {
  const { createAdkAgent } = reload();
  const fn = () => "Dynamic instruction.";

  createAdkAgent({ name: "fn_agent", model: {}, instruction: fn });
  assert.equal(lastAgentConfig.instruction, fn, "function instruction passed through unchanged");
});
