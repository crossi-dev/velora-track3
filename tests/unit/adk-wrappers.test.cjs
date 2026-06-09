// Unit tests for ADK Employee + Supervisor agent wrappers.
// G3-1 — Phase 2-7 audit: ADK wrappers shipped sin tests.
//
// Strategy: mock @google/adk's Agent + InMemoryRunner to capture how the
// wrapper composes prompts + history + user message. Avoid hitting real
// Vertex AI in unit tests.

const assert = require("node:assert/strict");
const test = require("node:test");
const Module = require("node:module");
const path = require("node:path");

// ── Module mocking infrastructure ────────────────────────────────────

const SESSION_SERVICE_PATH = path.resolve(__dirname, "../../src/lib/adk/session-service.ts");

function clearCache(...absPaths) {
  for (const p of absPaths) delete Module._cache[p];
}

function installAdkMock(captures) {
  const adkPath = require.resolve("@google/adk");
  Module._cache[adkPath] = {
    id: adkPath,
    filename: adkPath,
    loaded: true,
    exports: {
      Agent: class FakeAgent {
        constructor(config) { captures.lastAgentConfig = config; }
      },
      // Runner is the canonical ADK runner (used by employee-agent.ts,
      // supervisor-agent.ts). The refactor from InMemoryRunner → Runner
      // (commit 698e0a9b) required adding this stub.
      Runner: class FakeRunner {
        constructor(config) { captures.lastRunnerConfig = config; }
        runAsync(params) {
          captures.lastRunParams = params;
          const events = captures.eventsToYield ?? [];
          return (async function* () { for (const e of events) yield e; })();
        }
        runEphemeral(params) {
          captures.lastRunParams = params;
          const events = captures.eventsToYield ?? [];
          return (async function* () { for (const e of events) yield e; })();
        }
      },
      InMemoryRunner: class FakeLegacyRunner {
        constructor(config) { captures.lastRunnerConfig = config; }
        runEphemeral(params) {
          captures.lastRunParams = params;
          // Build async generator yielding configured events.
          const events = captures.eventsToYield ?? [];
          return (async function* () { for (const e of events) yield e; })();
        }
      },
      Gemini: class FakeGemini {
        constructor(config) { captures.lastGeminiConfig = config; }
      },
      isFinalResponse: () => true,
      // getFunctionCalls: returns any function calls in the event's content parts.
      // Required by supervisor-agent.ts to detect in-band delegation tool invocations.
      getFunctionCalls: (event) => {
        const parts = event?.content?.parts ?? [];
        return parts.filter((p) => p.functionCall != null).map((p) => p.functionCall);
      },
      // getFunctionResponses: returns any function responses in the event's content parts.
      // Required by employee-agent.ts to capture tool results from the ADK stream.
      getFunctionResponses: (event) => {
        const parts = event?.content?.parts ?? [];
        return parts.filter((p) => p.functionResponse != null).map((p) => p.functionResponse);
      },
      // session-service.ts imports BaseSessionService and createEvent from @google/adk.
      // Must be included so session-service.ts compiles without falling back to the
      // real @google/adk import chain (which would pull in google-auth-library etc.).
      BaseSessionService: class FakeBaseSessionService {},
      createEvent: (e) => e,
      // supervisor-agent.ts + employee-agent.ts use `new InMemorySessionService()`
      // as a fallback when no businessId is provided. Under ts-node CJS transform,
      // the static import resolves through this mock. Must be a valid constructor
      // with all session methods used by both agents.
      InMemorySessionService: class FakeInMemorySessionService {
        constructor() {}
        async createSession() { return {}; }
        async getSession() { return null; }
        async getOrCreateSession() { return {}; }
        async listSessions() { return { sessions: [] }; }
        async deleteSession() {}
      },
      // capability-toolset.ts imports BaseToolset and extends it at class-declaration time.
      // When capability-toolset.ts is cleared from Module._cache by capability-toolset.test.cjs
      // and then re-required with this mock in scope, `class CapabilityToolset extends BaseToolset`
      // would fail with "Class extends value undefined" if BaseToolset is absent here.
      // FakeBaseToolset only needs to be a valid constructor — CapabilityToolset.getTools()
      // does not call any BaseToolset methods (it overrides them entirely).
      // JD Round 2 BLOCK #1 fix — see docs/REFACTOR_STEP1_5B_ROUND2.md.
      BaseToolset: class FakeBaseToolset {
        constructor() {}
      },
    },
  };
}

function installGeminiConfigMock(captures) {
  const cfgPath = require("path").resolve(__dirname, "../../src/lib/adk/gemini-config.ts");
  Module._cache[cfgPath] = {
    id: cfgPath,
    filename: cfgPath,
    loaded: true,
    exports: {
      getAdkEmployeeModel: () => captures.fakeEmployeeModel ?? { kind: "gemini-flash-mock" },
      getAdkSupervisorModel: () => captures.fakeSupervisorModel ?? { kind: "gemini-pro-mock" },
    },
  };
}

const EMPLOYEE_PATH = path.resolve(__dirname, "../../src/lib/adk/employee-agent.ts");
const SUPERVISOR_PATH = path.resolve(__dirname, "../../src/lib/adk/supervisor-agent.ts");
// capability-toolset.ts is imported by supervisor-agent.ts. capability-toolset.test.cjs
// evicts it from Module._cache in loadToolsetModule() so the real @google/adk is used
// for that test suite. When run-all.cjs then runs this file, supervisor-agent.ts
// re-requires capability-toolset.ts — which picks up the ADK mock. Without BaseToolset
// in the mock, `class CapabilityToolset extends BaseToolset` throws TypeError.
// Solution: clear capability-toolset.ts alongside supervisor-agent.ts so it is
// re-evaluated with the current mock (which now exports FakeBaseToolset).
// JD Round 2 BLOCK #1 fix — see docs/REFACTOR_STEP1_5B_ROUND2.md.
const CAPABILITY_TOOLSET_PATH = path.resolve(__dirname, "../../src/lib/adk/capability-toolset.ts");

// Also clear session-service when reloading agents so it re-imports with the
// current Module._cache mock for @google/adk (BaseSessionService, createEvent).
// Without this, a cached session-service.ts holds a reference to whatever
// @google/adk was in cache when it first loaded — which may be an incomplete
// mock missing BaseSessionService, causing a TypeError on class extend.
function loadEmployee() {
  clearCache(EMPLOYEE_PATH, SESSION_SERVICE_PATH);
  return require(EMPLOYEE_PATH);
}
function loadSupervisor() {
  // Clear capability-toolset.ts as well: it imports BaseToolset from @google/adk at
  // class-declaration time. If it was previously evicted (by capability-toolset.test.cjs)
  // and re-evaluated with a mock missing BaseToolset, class extension fails. Clearing it
  // here forces a fresh evaluation against the current mock (which exports FakeBaseToolset).
  clearCache(SUPERVISOR_PATH, SESSION_SERVICE_PATH, CAPABILITY_TOOLSET_PATH);
  return require(SUPERVISOR_PATH);
}

// ── Employee Agent tests ─────────────────────────────────────────────

test("runEmployeeAgentViaAdk: creates Agent with system prompt + Gemini model", async () => {
  const captures = { eventsToYield: [{ content: { parts: [{ text: '{"intent":"answer"}' }] } }] };
  installAdkMock(captures);
  installGeminiConfigMock(captures);
  const { runEmployeeAgentViaAdk } = loadEmployee();
  await runEmployeeAgentViaAdk({
    systemPrompt: "Sos el empleado de Velora",
    history: [],
    userMessage: "vendí 2 cubiertas",
  });
  // instruction is a callback (instructionFn) — ADK passes it as () => string to bypass
  // ADK's session-state template resolution for {placeholder} variables in system prompts.
  // Must call it to get the actual instruction text.
  const instruction = typeof captures.lastAgentConfig.instruction === "function"
    ? captures.lastAgentConfig.instruction()
    : captures.lastAgentConfig.instruction;
  assert.equal(captures.lastAgentConfig.name, "velora_employee");
  assert.match(instruction, /Sos el empleado de Velora/);
  assert.equal(captures.lastAgentConfig.model.kind, "gemini-flash-mock");
});

test("runEmployeeAgentViaAdk: embeds history into instruction prefix", async () => {
  const captures = { eventsToYield: [{ content: { parts: [{ text: "{}" }] } }] };
  installAdkMock(captures);
  installGeminiConfigMock(captures);
  const { runEmployeeAgentViaAdk } = loadEmployee();
  await runEmployeeAgentViaAdk({
    systemPrompt: "Base prompt",
    history: [
      { role: "user", parts: [{ text: "hola" }] },
      { role: "model", parts: [{ text: "Hola, ¿en qué te ayudo?" }] },
    ],
    userMessage: "vendí 3 X",
  });
  const instruction = typeof captures.lastAgentConfig.instruction === "function"
    ? captures.lastAgentConfig.instruction()
    : captures.lastAgentConfig.instruction;
  assert.match(instruction, /Usuario: hola/);
  assert.match(instruction, /Velora: Hola/);
});

test("runEmployeeAgentViaAdk: returns concatenated text from runner events", async () => {
  const captures = {
    eventsToYield: [
      { content: { parts: [{ text: "intermediate" }] } },
      { content: { parts: [{ text: '{"intent":"register_sale"}' }] } },
    ],
  };
  installAdkMock(captures);
  installGeminiConfigMock(captures);
  const { runEmployeeAgentViaAdk } = loadEmployee();
  const result = await runEmployeeAgentViaAdk({
    systemPrompt: "p",
    history: [],
    userMessage: "test",
  });
  // El wrapper guarda el ÚLTIMO texto, no concatena — verificamos esto.
  assert.equal(result.text, '{"intent":"register_sale"}');
});

test("runEmployeeAgentViaAdk: empty history → no historial block in instruction", async () => {
  const captures = { eventsToYield: [{ content: { parts: [{ text: "{}" }] } }] };
  installAdkMock(captures);
  installGeminiConfigMock(captures);
  const { runEmployeeAgentViaAdk } = loadEmployee();
  await runEmployeeAgentViaAdk({ systemPrompt: "P", history: [], userMessage: "x" });
  const instruction = typeof captures.lastAgentConfig.instruction === "function"
    ? captures.lastAgentConfig.instruction()
    : captures.lastAgentConfig.instruction;
  // History block NO debería aparecer cuando history=[]
  assert.doesNotMatch(instruction, /HISTORIAL DEL CHAT/);
});

test("runEmployeeAgentViaAdk: passes user message via runner.runEphemeral", async () => {
  const captures = { eventsToYield: [{ content: { parts: [{ text: "{}" }] } }] };
  installAdkMock(captures);
  installGeminiConfigMock(captures);
  const { runEmployeeAgentViaAdk } = loadEmployee();
  await runEmployeeAgentViaAdk({ systemPrompt: "p", history: [], userMessage: "vendí 5 Y" });
  assert.equal(captures.lastRunParams.newMessage.role, "user");
  assert.equal(captures.lastRunParams.newMessage.parts[0].text, "vendí 5 Y");
});

test("runEmployeeAgentViaAdk: empty event stream returns empty text", async () => {
  const captures = { eventsToYield: [] };
  installAdkMock(captures);
  installGeminiConfigMock(captures);
  const { runEmployeeAgentViaAdk } = loadEmployee();
  const result = await runEmployeeAgentViaAdk({ systemPrompt: "p", history: [], userMessage: "x" });
  assert.equal(result.text, "");
});

// ── Supervisor Agent tests ─────────────────────────────────────────────

test("runSupervisorAgentViaAdk: uses Gemini Pro (supervisor model)", async () => {
  const captures = { eventsToYield: [{ content: { parts: [{ text: "{}" }] } }] };
  installAdkMock(captures);
  installGeminiConfigMock(captures);
  const { runSupervisorAgentViaAdk } = loadSupervisor();
  await runSupervisorAgentViaAdk({
    systemPrompt: "Sos el supervisor",
    userMessage: "EMPLOYEE_EVENT type:LOW_STOCK",
  });
  assert.equal(captures.lastAgentConfig.name, "velora_supervisor");
  assert.equal(captures.lastAgentConfig.model.kind, "gemini-pro-mock");
});

test("runSupervisorAgentViaAdk: returns last event text", async () => {
  const captures = {
    eventsToYield: [
      { content: { parts: [{ text: '{"kind":"notification","level":"now"}' }] } },
    ],
  };
  installAdkMock(captures);
  installGeminiConfigMock(captures);
  const { runSupervisorAgentViaAdk } = loadSupervisor();
  const result = await runSupervisorAgentViaAdk({ systemPrompt: "p", userMessage: "x" });
  assert.match(result.text, /notification/);
});

test("runSupervisorAgentViaAdk: passes user message verbatim", async () => {
  const captures = { eventsToYield: [] };
  installAdkMock(captures);
  installGeminiConfigMock(captures);
  const { runSupervisorAgentViaAdk } = loadSupervisor();
  await runSupervisorAgentViaAdk({
    systemPrompt: "p",
    userMessage: "EMPLOYEE_EVENT\nbusinessId:abc\neventId:evt-1",
  });
  assert.equal(
    captures.lastRunParams.newMessage.parts[0].text,
    "EMPLOYEE_EVENT\nbusinessId:abc\neventId:evt-1",
  );
});

// ADK double-inject regression: Runner + ChatMessageSessionService replays history
// natively via getSession. supervisor-runner.ts must NOT prepend a history prefix
// blob to userMessage on the ADK path — doing so would feed prior turns twice.
// Source: https://adk.dev/sessions/session/ (verified HTTP 200 2026-05-28)
test("runSupervisorAgentViaAdk: does not prepend history prefix to userMessage", async () => {
  const captures = { eventsToYield: [] };
  installAdkMock(captures);
  installGeminiConfigMock(captures);
  const { runSupervisorAgentViaAdk } = loadSupervisor();
  const targetMessage = "¿cuántas cubiertas quedan?";
  await runSupervisorAgentViaAdk({
    systemPrompt: "p",
    userMessage: targetMessage,
  });
  const sent = captures.lastRunParams.newMessage.parts[0].text;
  // The runner must receive exactly the userMessage — no history prefix block injected.
  assert.equal(sent, targetMessage);
  assert.ok(!sent.includes("CONTEXTO DE LA CONVERSACIÓN ANTERIOR"),
    "ADK path must not prepend a history prefix blob (double-inject)");
});
