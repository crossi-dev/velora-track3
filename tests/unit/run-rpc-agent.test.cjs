"use strict";

// Unit tests for the shared runRpcAgent helper.
//
// Covers:
//   1. Happy path — runEphemeral yields a final-response event → replyText extracted.
//   2. onFunctionResponse callback — invoked with correct name/response per tool event.
//   3. Timeout — exceeding timeoutMs resolves with error.name === "TimeoutError".
//   4. Runner throws — any throw is captured in result.error (never rethrown).
//   5. breakOnFirstFinalResponse — exits after the first final-response event.
//   6. No final-response events — replyText is empty string, error is null.
//   7. maxLlmCalls — passed through to runEphemeral runConfig.

const assert = require("node:assert/strict");
const test = require("node:test");
const Module = require("node:module");
const path = require("node:path");

// ── ADK mock ──────────────────────────────────────────────────────────────────

const RPC_AGENT_PATH = path.resolve(__dirname, "../../src/app/api/agents/_lib/run-rpc-agent.ts");
const CLOUD_LOGGER_PATH = path.resolve(__dirname, "../../src/lib/cloud-logger.ts");

function buildAdkMock({ events = [], runShouldThrow = null } = {}) {
  return {
    InMemoryRunner: class FakeInMemoryRunner {
      constructor(config) {
        this._config = config;
      }
      runEphemeral(params) {
        this._lastRunParams = params;
        FakeInMemoryRunner.lastInstance = this;
        FakeInMemoryRunner.lastRunParams = params;
        if (runShouldThrow) {
          return (async function* () {
            throw runShouldThrow;
          })();
        }
        const eventsToYield = events;
        return (async function* () {
          for (const e of eventsToYield) yield e;
        })();
      }
    },
    isFinalResponse: (event) => Boolean(event._isFinalResponse),
    getFunctionResponses: (event) => {
      return (event._funcResponses ?? []);
    },
    // Agent type satisfies the import — not used directly by runRpcAgent.
    Agent: class FakeAgent {},
  };
}

function loadRunRpcAgent({ events = [], runShouldThrow = null } = {}) {
  // Clear cached modules so each test gets a fresh load.
  delete Module._cache[RPC_AGENT_PATH];
  delete Module._cache[CLOUD_LOGGER_PATH];

  const adkPath = require.resolve("@google/adk");
  Module._cache[adkPath] = {
    id: adkPath,
    filename: adkPath,
    loaded: true,
    exports: buildAdkMock({ events, runShouldThrow }),
  };

  return require(RPC_AGENT_PATH);
}

function makeFakeAgent() {
  return { _fake: true };
}

function finalEvent(text) {
  return {
    _isFinalResponse: true,
    content: { parts: [{ text }] },
    _funcResponses: [],
  };
}

function funcResponseEvent(name, response) {
  return {
    _isFinalResponse: false,
    _funcResponses: [{ name, response }],
  };
}

// ── 1. Happy path ─────────────────────────────────────────────────────────────

test("runRpcAgent — happy path returns replyText and null error", async () => {
  const { runRpcAgent } = loadRunRpcAgent({
    events: [finalEvent("Hola desde el agente")],
  });
  const result = await runRpcAgent({
    agent: makeFakeAgent(),
    appName: "test-agent",
    userId: "test-user",
    message: "Probá",
    timeoutMs: 5_000,
  });
  assert.equal(result.replyText, "Hola desde el agente");
  assert.equal(result.error, null);
});

// ── 2. onFunctionResponse callback ───────────────────────────────────────────

test("runRpcAgent — onFunctionResponse receives tool name and response", async () => {
  const captured = [];
  const { runRpcAgent } = loadRunRpcAgent({
    events: [
      funcResponseEvent("create_payment_link", { paymentIntentId: "pi_123" }),
      finalEvent("Link creado"),
    ],
  });
  await runRpcAgent({
    agent: makeFakeAgent(),
    appName: "test-agent",
    userId: "test-user",
    message: "Cobrar",
    timeoutMs: 5_000,
    onFunctionResponse: (item) => captured.push(item),
  });
  assert.equal(captured.length, 1);
  assert.equal(captured[0].name, "create_payment_link");
  assert.deepEqual(captured[0].response, { paymentIntentId: "pi_123" });
});

test("runRpcAgent — onFunctionResponse called for multiple tool events", async () => {
  const names = [];
  const { runRpcAgent } = loadRunRpcAgent({
    events: [
      funcResponseEvent("tool_a", { x: 1 }),
      funcResponseEvent("tool_b", { y: 2 }),
      finalEvent("Done"),
    ],
  });
  await runRpcAgent({
    agent: makeFakeAgent(),
    appName: "test-agent",
    userId: "test-user",
    message: "Go",
    timeoutMs: 5_000,
    onFunctionResponse: ({ name }) => names.push(name),
  });
  assert.deepEqual(names, ["tool_a", "tool_b"]);
});

test("runRpcAgent — onFunctionResponse receives null for non-object response", async () => {
  const captured = [];
  const { runRpcAgent } = loadRunRpcAgent({
    events: [
      { _isFinalResponse: false, _funcResponses: [{ name: "tool_x", response: "string-not-object" }] },
      finalEvent("ok"),
    ],
  });
  await runRpcAgent({
    agent: makeFakeAgent(),
    appName: "test-agent",
    userId: "test-user",
    message: "Go",
    timeoutMs: 5_000,
    onFunctionResponse: (item) => captured.push(item),
  });
  assert.equal(captured[0].response, null);
});

// ── 3. Timeout ────────────────────────────────────────────────────────────────

test("runRpcAgent — timeout produces error.name === 'TimeoutError'", async () => {
  // Use a generator that yields slowly, allowing the timeout to fire first.
  // The generator yields after a 5s delay; the test timeout is 50ms.
  let adkPath;
  try { adkPath = require.resolve("@google/adk"); } catch { adkPath = null; }
  if (adkPath) delete Module._cache[adkPath];
  delete Module._cache[RPC_AGENT_PATH];

  // A flag to signal the generator to stop when cleaned up.
  let stopped = false;

  if (adkPath) {
    Module._cache[adkPath] = {
      id: adkPath, filename: adkPath, loaded: true,
      exports: {
        InMemoryRunner: class {
          runEphemeral() {
            return (async function* () {
              try {
                // Yield nothing for 5s — timeout fires well before this.
                await new Promise((resolve) => setTimeout(resolve, 5_000));
                if (!stopped) yield finalEvent("never");
              } finally {
                stopped = true;
              }
            })();
          }
        },
        isFinalResponse: () => false,
        getFunctionResponses: () => [],
        Agent: class {},
      },
    };
  }

  const { runRpcAgent } = require(RPC_AGENT_PATH);
  const result = await runRpcAgent({
    agent: makeFakeAgent(),
    appName: "test-agent",
    userId: "test-user",
    message: "Go",
    timeoutMs: 50, // Very short — will time out before the generator yields.
  });

  assert.notEqual(result.error, null, "error must be non-null on timeout");
  assert.equal(
    result.error instanceof Error && result.error.name,
    "TimeoutError",
    `expected TimeoutError, got ${result.error}`,
  );
});

// ── 4. Runner throws ──────────────────────────────────────────────────────────

test("runRpcAgent — generator throw captured in result.error, never rethrown", async () => {
  const boom = new Error("ADK boom");
  const { runRpcAgent } = loadRunRpcAgent({ runShouldThrow: boom });
  let threw = false;
  let result;
  try {
    result = await runRpcAgent({
      agent: makeFakeAgent(),
      appName: "test-agent",
      userId: "test-user",
      message: "Go",
      timeoutMs: 5_000,
    });
  } catch {
    threw = true;
  }
  assert.equal(threw, false, "runRpcAgent must not rethrow");
  assert.equal(result.error, boom);
  assert.equal(result.replyText, "");
});

// ── 5. breakOnFirstFinalResponse ─────────────────────────────────────────────

test("runRpcAgent — breakOnFirstFinalResponse stops after first isFinalResponse", async () => {
  const visited = [];
  const { runRpcAgent } = loadRunRpcAgent({
    events: [
      { _isFinalResponse: true, content: { parts: [{ text: "first" }] }, _funcResponses: [] },
      // Second final-response should NOT be visited when breakOnFirstFinalResponse=true.
      { _isFinalResponse: true, content: { parts: [{ text: "second" }] }, _funcResponses: [] },
    ],
  });
  const result = await runRpcAgent({
    agent: makeFakeAgent(),
    appName: "test-agent",
    userId: "test-user",
    message: "Go",
    timeoutMs: 5_000,
    breakOnFirstFinalResponse: true,
    onFunctionResponse: () => { visited.push("func"); },
  });
  // replyText should be "first" (stopped before "second").
  assert.equal(result.replyText, "first");
  assert.equal(result.error, null);
});

test("runRpcAgent — without breakOnFirstFinalResponse processes all events", async () => {
  const { runRpcAgent } = loadRunRpcAgent({
    events: [
      { _isFinalResponse: true, content: { parts: [{ text: "first" }] }, _funcResponses: [] },
      { _isFinalResponse: true, content: { parts: [{ text: "second" }] }, _funcResponses: [] },
    ],
  });
  const result = await runRpcAgent({
    agent: makeFakeAgent(),
    appName: "test-agent",
    userId: "test-user",
    message: "Go",
    timeoutMs: 5_000,
    // breakOnFirstFinalResponse defaults to false.
  });
  // Last text wins when all events are drained.
  assert.equal(result.replyText, "second");
});

// ── 6. No final-response events ───────────────────────────────────────────────

test("runRpcAgent — no isFinalResponse events → replyText empty, no error", async () => {
  const { runRpcAgent } = loadRunRpcAgent({
    events: [
      { _isFinalResponse: false, _funcResponses: [] },
      { _isFinalResponse: false, _funcResponses: [] },
    ],
  });
  const result = await runRpcAgent({
    agent: makeFakeAgent(),
    appName: "test-agent",
    userId: "test-user",
    message: "Go",
    timeoutMs: 5_000,
  });
  assert.equal(result.replyText, "");
  assert.equal(result.error, null);
});

// ── 7. maxLlmCalls passthrough ────────────────────────────────────────────────

test("runRpcAgent — maxLlmCalls is forwarded to runEphemeral runConfig", async () => {
  const { runRpcAgent } = loadRunRpcAgent({ events: [finalEvent("ok")] });
  const InMemoryRunner = require("@google/adk").InMemoryRunner;

  await runRpcAgent({
    agent: makeFakeAgent(),
    appName: "test-agent",
    userId: "test-user",
    message: "Go",
    timeoutMs: 5_000,
    maxLlmCalls: 7,
  });

  const lastParams = InMemoryRunner.lastRunParams;
  assert.ok(lastParams, "runEphemeral must have been called");
  assert.equal(lastParams.runConfig?.maxLlmCalls, 7);
});

test("runRpcAgent — maxLlmCalls defaults to 10 when not specified", async () => {
  const { runRpcAgent } = loadRunRpcAgent({ events: [finalEvent("ok")] });
  const InMemoryRunner = require("@google/adk").InMemoryRunner;

  await runRpcAgent({
    agent: makeFakeAgent(),
    appName: "test-agent",
    userId: "test-user",
    message: "Go",
    timeoutMs: 5_000,
  });

  const lastParams = InMemoryRunner.lastRunParams;
  assert.equal(lastParams.runConfig?.maxLlmCalls, 10);
});
