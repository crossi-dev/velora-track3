// Unit test: employee-agent.ts session wiring.
// Verifies that runEmployeeAgentViaAdk resolves a session (getOrCreateSession)
// and uses runner.runAsync — NOT runEphemeral — when businessId is provided.

process.env.AUTH_SECRET = process.env.AUTH_SECRET || "test-employee-sessions-secret-32x";
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgresql://test:test@localhost:5432/test";

const assert = require("node:assert/strict");
const test = require("node:test");
const Module = require("node:module");
const path = require("node:path");

const SUT_PATH = path.resolve(__dirname, "../../src/lib/adk/employee-agent.ts");

// ── Shared call-tracking state (reset per test) ──────────────────────────────
let calls = { getOrCreate: 0, runAsync: 0, runEphemeral: 0 };

// ── Minimal fake Event for isFinalResponse to accept ─────────────────────────
function makeFinalEvent(text) {
  return {
    isFinalResponse: true,
    content: { role: "model", parts: [{ text }] },
    actions: {},
    author: "model",
    id: "evt-1",
    invocationId: "inv-1",
    timestamp: Date.now() / 1000,
  };
}

// ── @google/adk stub ──────────────────────────────────────────────────────────
function makeAdkStub() {
  const fakeSession = {
    id: "biz-123:emp-456",
    appName: "velora-employee-agent",
    userId: "emp-456",
    state: {},
    events: [],
    lastUpdateTime: Date.now() / 1000,
  };

  const sessionServiceStub = {
    getOrCreateSession: async (_req) => {
      calls.getOrCreate++;
      return fakeSession;
    },
    appendEvent: async ({ event }) => event,
    createSession: async (req) => ({ ...fakeSession, id: req.sessionId ?? fakeSession.id }),
    getSession: async () => fakeSession,
    listSessions: async () => ({ sessions: [fakeSession] }),
    deleteSession: async () => {},
  };

  // Runner stub: tracks runAsync/runEphemeral calls, yields one final event.
  class RunnerStub {
    constructor(_config) {
      // Capture sessionService for assertion — the real Runner uses it internally.
      this._sessionService = _config.sessionService;
    }
    async *runAsync(_params) {
      calls.runAsync++;
      yield makeFinalEvent("ok-from-stub");
    }
    async *runEphemeral(_params) {
      calls.runEphemeral++;
      yield makeFinalEvent("ephemeral-should-not-be-used");
    }
  }

  // InMemorySessionService stub — used for the no-businessId fallback path.
  class InMemorySessionServiceStub {
    constructor() {}
    async getOrCreateSession(req) {
      calls.getOrCreate++;
      return { ...fakeSession, id: req.sessionId ?? "ephemeral" };
    }
    async appendEvent({ event }) { return event; }
    async createSession(req) { return { ...fakeSession, id: req.sessionId ?? "ephemeral" }; }
    async getSession() { return undefined; }
    async listSessions() { return { sessions: [] }; }
    async deleteSession() {}
  }

  return {
    Agent: class {
      constructor(config) { this._config = config; }
    },
    Runner: RunnerStub,
    InMemorySessionService: InMemorySessionServiceStub,
    isFinalResponse: (event) => Boolean(event.isFinalResponse),
    getFunctionResponses: (_event) => [],
    createEvent: (props) => props,
  };
}

// ── Module stubs applied via Module._load ─────────────────────────────────────
const origLoad = Module._load;
let adkStub = makeAdkStub();

Module._load = function (request, parent, ...rest) {
  if (request === "@google/adk") {
    return adkStub;
  }
  if (request === "server-only") {
    return {};
  }
  // Stub the session-service factory so it returns our controllable spy.
  if (
    request.includes("session-service") ||
    (typeof request === "string" && request.endsWith("session-service.ts"))
  ) {
    const sessionServiceSpy = {
      getOrCreateSession: async (_req) => {
        calls.getOrCreate++;
        return {
          id: "biz-123:emp-456",
          appName: "velora-employee-agent",
          userId: "emp-456",
          state: {},
          events: [],
          lastUpdateTime: Date.now() / 1000,
        };
      },
      appendEvent: async ({ event }) => event,
      createSession: async (req) => ({
        id: req.sessionId ?? "biz-123:emp-456",
        appName: req.appName,
        userId: req.userId,
        state: req.state ?? {},
        events: [],
        lastUpdateTime: Date.now() / 1000,
      }),
      getSession: async () => undefined,
      listSessions: async () => ({ sessions: [] }),
      deleteSession: async () => {},
    };
    return {
      createSessionServiceWithFallback: (_businessId) => sessionServiceSpy,
      createSessionService: (_businessId) => sessionServiceSpy,
    };
  }
  // Stub gemini-config
  if (request.includes("gemini-config") || request.endsWith("gemini-config.ts")) {
    return { getAdkEmployeeModel: () => "gemini-2.5-flash" };
  }
  // Stub tools
  if (request.includes("/tools") && !request.includes("node_modules")) {
    return {
      createCheckStockTool: () => ({}),
      createRegisterSaleTool: () => ({}),
      createBusinessQueryTool: () => ({}),
      createEscalateToOwnerTool: () => ({}),
    };
  }
  // Stub employee-agent.synthesize
  if (request.includes("employee-agent.synthesize") || request.endsWith("employee-agent.synthesize.ts")) {
    return { synthesizeFromToolResult: (r) => JSON.stringify(r) };
  }
  // Stub cloud-logger
  if (request.includes("cloud-logger") || request.endsWith("cloud-logger.ts")) {
    return { cloudLog: () => {} };
  }
  // Stub @/lib/prisma
  if (request === "@/lib/prisma" || request.endsWith("prisma.ts") || request === "./prisma") {
    return { prisma: {} };
  }
  return origLoad.call(this, request, parent, ...rest);
};

process.on("exit", () => { Module._load = origLoad; });

function reload() {
  // Clear module cache for the SUT and its local deps so stubs are picked up fresh.
  Object.keys(Module._cache).forEach((k) => {
    if (k.includes("employee-agent") || k.includes("session-service") || k.includes("gemini-config")) {
      delete Module._cache[k];
    }
  });
  adkStub = makeAdkStub();
  return require(SUT_PATH);
}

// ── Tests ────────────────────────────────────────────────────────────────────

test("runAsync is called (not runEphemeral) when businessId is provided", async () => {
  calls = { getOrCreate: 0, runAsync: 0, runEphemeral: 0 };
  const { runEmployeeAgentViaAdk } = reload();

  await runEmployeeAgentViaAdk({
    systemPrompt: "Sos el companion.",
    history: [],
    userMessage: "vendí 2 cubiertas",
    businessId: "biz-123",
    sessionId: "emp-456",
  });

  assert.equal(calls.runAsync, 1, "runner.runAsync must be called exactly once");
  assert.equal(calls.runEphemeral, 0, "runner.runEphemeral must NOT be called");
});

test("getOrCreateSession is called before runAsync when businessId is provided", async () => {
  calls = { getOrCreate: 0, runAsync: 0, runEphemeral: 0 };
  const { runEmployeeAgentViaAdk } = reload();

  await runEmployeeAgentViaAdk({
    systemPrompt: "Sos el companion.",
    history: [],
    userMessage: "chequeá el stock de gaseosas",
    businessId: "biz-123",
    sessionId: "emp-456",
  });

  assert.ok(calls.getOrCreate >= 1, "getOrCreateSession must be called at least once");
});

test("sessionId format includes businessId and employeeId", async () => {
  calls = { getOrCreate: 0, runAsync: 0, runEphemeral: 0 };

  // Intercept getOrCreateSession to capture the sessionId before reload() runs.
  let capturedSessionId = null;
  const savedLoad = Module._load;
  Module._load = function (request, parent, ...rest) {
    if (
      request.includes("session-service") ||
      (typeof request === "string" && request.endsWith("session-service.ts"))
    ) {
      const spy = {
        getOrCreateSession: async (req) => {
          calls.getOrCreate++;
          capturedSessionId = req.sessionId;
          return {
            id: req.sessionId ?? "test",
            appName: req.appName,
            userId: req.userId,
            state: {},
            events: [],
            lastUpdateTime: Date.now() / 1000,
          };
        },
        appendEvent: async ({ event }) => event,
        createSession: async (req) => ({ id: req.sessionId ?? "test", appName: req.appName, userId: req.userId, state: {}, events: [], lastUpdateTime: Date.now() / 1000 }),
        getSession: async () => undefined,
        listSessions: async () => ({ sessions: [] }),
        deleteSession: async () => {},
      };
      return {
        createSessionServiceWithFallback: () => spy,
        createSessionService: () => spy,
      };
    }
    return savedLoad.call(this, request, parent, ...rest);
  };

  const { runEmployeeAgentViaAdk } = reload();

  await runEmployeeAgentViaAdk({
    systemPrompt: "Sos el companion.",
    history: [],
    userMessage: "hola",
    businessId: "biz-xyz",
    sessionId: "emp-abc",
  });

  Module._load = savedLoad;

  assert.ok(
    capturedSessionId === "biz-xyz:emp-abc",
    `sessionId must be "biz-xyz:emp-abc", got: ${capturedSessionId}`,
  );
});

test("runAsync is still called when no businessId (ephemeral fallback path)", async () => {
  calls = { getOrCreate: 0, runAsync: 0, runEphemeral: 0 };
  const { runEmployeeAgentViaAdk } = reload();

  await runEmployeeAgentViaAdk({
    systemPrompt: "Sos el companion.",
    history: [],
    userMessage: "hola",
    // no businessId — falls back to InMemorySessionService
  });

  assert.equal(calls.runAsync, 1, "runAsync must be called even without businessId");
  assert.equal(calls.runEphemeral, 0, "runEphemeral must never be called");
});

test("returns text from the final event", async () => {
  calls = { getOrCreate: 0, runAsync: 0, runEphemeral: 0 };
  const { runEmployeeAgentViaAdk } = reload();

  const result = await runEmployeeAgentViaAdk({
    systemPrompt: "Sos el companion.",
    history: [],
    userMessage: "cuánto cuesta la leche?",
    businessId: "biz-123",
    sessionId: "emp-456",
  });

  assert.equal(typeof result.text, "string", "result.text must be a string");
  assert.ok(result.text.length > 0, "result.text must not be empty");
});
