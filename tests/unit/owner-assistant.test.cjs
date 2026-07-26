// Unit tests for Owner Assistant Phase 1.
//
// Tests:
//   1. Verbless create_product ("bizcochuelo 50 unidades 20 pesos") → correct extraction
//   2. Explicit create_product ("agregar alfajor a 150 pesos 10 unidades") → correct extraction
//   3. Verbless stock_load ("llegaron 20 de coca cola a 800") → correct extraction
//   4. adjust_stock ("el stock de pan es 12") → mode=set extraction
//   5. AUTO mode — agent config must NOT have toolConfig.mode=ANY
//   6. Flag OFF → stage returns null (no-op, Supervisor path unchanged)
//
// Strategy: mock @google/adk + gemini-config + cloud-logger + prisma.
// No real Vertex AI calls. The mock runner yields a fake tool-call event.

"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const Module = require("node:module");
const path = require("node:path");

// ── Paths ──────────────────────────────────────────────────────────────

const WORKTREE_ROOT = path.resolve(__dirname, "../..");

const OWNER_ASSISTANT_PATH = path.resolve(WORKTREE_ROOT, "src/lib/adk/owner-assistant.ts");
const SESSION_SERVICE_PATH = path.resolve(WORKTREE_ROOT, "src/lib/adk/session-service.ts");
const GEMINI_CONFIG_PATH = path.resolve(WORKTREE_ROOT, "src/lib/adk/gemini-config.ts");
const CATALOG_PATH = path.resolve(WORKTREE_ROOT, "src/lib/adk/owner-assistant-catalog.ts");
const CLOUD_LOGGER_PATH = path.resolve(WORKTREE_ROOT, "src/lib/cloud-logger.ts");
const STAGE_PATH = path.resolve(
  WORKTREE_ROOT,
  "src/app/api/business-assistant/_lib/owner-handler.stages-owner-assistant.ts",
);
const CONTEXT_PATH = path.resolve(
  WORKTREE_ROOT,
  "src/app/api/business-assistant/_lib/context.ts",
);
const MAPPER_PATH = path.resolve(
  WORKTREE_ROOT,
  "src/app/api/business-assistant/_lib/supervisor-action-mapper.ts",
);

function clearOwnerAssistantCache() {
  for (const p of [
    OWNER_ASSISTANT_PATH,
    SESSION_SERVICE_PATH,
    STAGE_PATH,
  ]) {
    delete Module._cache[p];
  }
}

// ── ADK mock builder ──────────────────────────────────────────────────

/**
 * Build a fake ADK mock where runAsync yields a function-call event followed
 * by a function-response event with the given tool name + args.
 */
function buildAdkMockForToolCall(captures, toolName, toolArgs) {
  // Simulate: the LLM emits a functionCall event, then the framework executes
  // the tool and emits a functionResponse event, then emits the final text event.
  // The intent tool's execute() returns { intent, data, summary } — we embed that
  // in the functionResponse.
  const fnCallEvent = {
    content: {
      parts: [{ functionCall: { name: toolName, args: toolArgs } }],
    },
  };
  const fnResponseEvent = {
    content: {
      parts: [{
        functionResponse: {
          name: toolName,
          response: {
            intent: toolName,
            data: toolArgs,
            summary: `${toolName} called`,
          },
        },
      }],
    },
  };
  const finalEvent = {
    content: { parts: [{ text: "Listo, preparé la confirmación." }] },
  };

  const adkPath = require.resolve("@google/adk");
  Module._cache[adkPath] = {
    id: adkPath,
    filename: adkPath,
    loaded: true,
    exports: {
      Agent: class FakeAgent {
        constructor(config) { captures.lastAgentConfig = config; }
      },
      Runner: class FakeRunner {
        constructor(config) { captures.lastRunnerConfig = config; }
        runAsync(params) {
          captures.lastRunParams = params;
          const events = [fnCallEvent, fnResponseEvent, finalEvent];
          return (async function* () { for (const e of events) yield e; })();
        }
      },
      InMemoryRunner: class FakeLegacyRunner {
        constructor(config) { captures.lastRunnerConfig = config; }
        runEphemeral() { return (async function* () { })(); }
      },
      Gemini: class FakeGemini {
        constructor(config) { captures.lastGeminiConfig = config; }
      },
      isFinalResponse: (event) => {
        // Final response is the last event with plain text
        const parts = event?.content?.parts ?? [];
        return parts.some((p) => typeof p.text === "string" && p.text.length > 0);
      },
      getFunctionCalls: (event) => {
        const parts = event?.content?.parts ?? [];
        return parts.filter((p) => p.functionCall != null).map((p) => p.functionCall);
      },
      getFunctionResponses: (event) => {
        const parts = event?.content?.parts ?? [];
        return parts.filter((p) => p.functionResponse != null).map((p) => p.functionResponse);
      },
      BaseSessionService: class FakeBaseSessionService {
        async appendEvent({ session, event }) {
          session.events = session.events ?? [];
          session.events.push(event);
          return event;
        }
      },
      createEvent: (e) => e,
      InMemorySessionService: class FakeInMemorySessionService {
        async createSession() { return { events: [], state: {} }; }
        async getSession() { return undefined; }
        async listSessions() { return { sessions: [] }; }
        async deleteSession() {}
      },
      BaseToolset: class FakeBaseToolset {},
      FunctionTool: class FakeFunctionTool {
        constructor(opts) { this.name = opts.name; this._execute = opts.execute; }
        async execute(args) { return this._execute(args); }
      },
    },
  };
}

function installGeminiConfigMock() {
  Module._cache[GEMINI_CONFIG_PATH] = {
    id: GEMINI_CONFIG_PATH, filename: GEMINI_CONFIG_PATH, loaded: true,
    exports: {
      getAdkCompanionModel: () => ({ kind: "gemini-flash-mock" }),
      getAdkSupervisorModel: () => ({ kind: "gemini-pro-mock" }),
      getAdkVentasModel: () => ({ kind: "gemini-flash-mock" }),
      getAdkCustomerModel: () => ({ kind: "gemini-flash-mock" }),
      getAdkFiscalModel: () => ({ kind: "gemini-flash-mock" }),
      getAdkPaymentsModel: () => ({ kind: "gemini-flash-mock" }),
      getAdkLogisticaModel: () => ({ kind: "gemini-flash-mock" }),
      getAdkEquipoModel: () => ({ kind: "gemini-flash-mock" }),
      getAdkCommunicationsModel: () => ({ kind: "gemini-flash-mock" }),
    },
  };
}

function installCatalogMock() {
  Module._cache[CATALOG_PATH] = {
    id: CATALOG_PATH, filename: CATALOG_PATH, loaded: true,
    exports: {
      buildOwnerCatalogSummary: async () => "Productos existentes:\n  alfajor: $200 (10 en stock)",
    },
  };
}

function installCloudLoggerMock() {
  Module._cache[CLOUD_LOGGER_PATH] = {
    id: CLOUD_LOGGER_PATH, filename: CLOUD_LOGGER_PATH, loaded: true,
    exports: { cloudLog: () => {} },
  };
}

function loadOwnerAssistant(captures, toolName, toolArgs) {
  buildAdkMockForToolCall(captures, toolName, toolArgs);
  installGeminiConfigMock();
  installCatalogMock();
  installCloudLoggerMock();
  clearOwnerAssistantCache();
  return require(OWNER_ASSISTANT_PATH);
}

// ── Test 1: Verbless create_product (the bizcochuelo bug) ─────────────

test("runOwnerAssistant: verbless create_product → extracts name/price/stock", async () => {
  const captures = {};
  const { runOwnerAssistant } = loadOwnerAssistant(captures, "create_product", {
    name: "bizcochuelo",
    price: 20,
    stock: 50,
  });

  const result = await runOwnerAssistant({
    businessId: "biz-1",
    actorUserId: "user-1",
    text: "producto bizcochuelo 50 unidades 20 pesos",
  });

  assert.ok(result.toolCall, "toolCall must be non-null");
  assert.equal(result.toolCall.intent, "create_product");
  assert.equal(result.toolCall.data.name, "bizcochuelo");
  assert.equal(result.toolCall.data.price, 20);
  assert.equal(result.toolCall.data.stock, 50);
});

// ── Test 2: Explicit create_product ──────────────────────────────────

test("runOwnerAssistant: explicit create_product → extracts correctly", async () => {
  const captures = {};
  const { runOwnerAssistant } = loadOwnerAssistant(captures, "create_product", {
    name: "alfajor triple",
    price: 350,
    stock: null,
  });

  const result = await runOwnerAssistant({
    businessId: "biz-1",
    actorUserId: "user-1",
    text: "agregar alfajor triple a 350 pesos",
  });

  assert.ok(result.toolCall, "toolCall must be non-null");
  assert.equal(result.toolCall.intent, "create_product");
  assert.equal(result.toolCall.data.name, "alfajor triple");
  assert.equal(result.toolCall.data.price, 350);
  assert.equal(result.toolCall.data.stock, null);
});

// ── Test 3: Verbless stock_load ───────────────────────────────────────

test("runOwnerAssistant: verbless stock_load → extracts itemName/quantity/unitPrice", async () => {
  const captures = {};
  const { runOwnerAssistant } = loadOwnerAssistant(captures, "stock_load", {
    itemName: "coca cola",
    quantity: 20,
    unitPrice: 800,
    supplierName: "",
  });

  const result = await runOwnerAssistant({
    businessId: "biz-1",
    actorUserId: "user-1",
    text: "llegaron 20 de coca cola a 800",
  });

  assert.ok(result.toolCall, "toolCall must be non-null");
  assert.equal(result.toolCall.intent, "stock_load");
  assert.equal(result.toolCall.data.itemName, "coca cola");
  assert.equal(result.toolCall.data.quantity, 20);
  assert.equal(result.toolCall.data.unitPrice, 800);
});

// ── Test 4: adjust_stock ──────────────────────────────────────────────

test("runOwnerAssistant: adjust_stock → mode=set extracted", async () => {
  const captures = {};
  const { runOwnerAssistant } = loadOwnerAssistant(captures, "adjust_stock", {
    productName: "pan",
    mode: "set",
    quantity: 12,
  });

  const result = await runOwnerAssistant({
    businessId: "biz-1",
    actorUserId: "user-1",
    text: "el stock de pan es 12",
  });

  assert.ok(result.toolCall, "toolCall must be non-null");
  assert.equal(result.toolCall.intent, "adjust_stock");
  assert.equal(result.toolCall.data.productName, "pan");
  assert.equal(result.toolCall.data.mode, "set");
  assert.equal(result.toolCall.data.quantity, 12);
});

// ── Test 5: AUTO mode — no toolConfig.mode=ANY ────────────────────────

test("runOwnerAssistant: agent uses AUTO mode (no toolConfig.mode=ANY)", async () => {
  const captures = {};
  const { runOwnerAssistant } = loadOwnerAssistant(captures, "create_product", {
    name: "test", price: 100, stock: null,
  });

  await runOwnerAssistant({
    businessId: "biz-1",
    actorUserId: "user-1",
    text: "producto test 100 pesos",
  });

  // generateContentConfig must not set toolConfig.mode to "ANY"
  const genConfig = captures.lastAgentConfig?.generateContentConfig ?? {};
  const toolConfigMode = genConfig?.toolConfig?.functionCallingConfig?.mode;
  assert.notEqual(
    toolConfigMode,
    "ANY",
    "toolConfig.mode must NOT be ANY — it causes the empty-reply loop (reverted 2026-05-29)",
  );
  // Additionally verify there is no toolConfig at all (preferred — defaults to AUTO)
  assert.equal(
    genConfig.toolConfig,
    undefined,
    "generateContentConfig must not set toolConfig (AUTO is the default when absent)",
  );
});

// ── Test 6: Flag OFF → stage returns null ─────────────────────────────

test("ownerAssistantStage: USE_OWNER_ASSISTANT unset → stage returns null", async () => {
  // Ensure flag is off
  delete process.env.USE_OWNER_ASSISTANT;

  // Install minimal mocks
  const captures = {};
  buildAdkMockForToolCall(captures, "create_product", { name: "x", price: 1, stock: null });
  installGeminiConfigMock();
  installCatalogMock();
  installCloudLoggerMock();

  // Clear stage + mapper + context from cache
  delete Module._cache[STAGE_PATH];
  delete Module._cache[CONTEXT_PATH];
  delete Module._cache[MAPPER_PATH];
  clearOwnerAssistantCache();

  const { ownerAssistantStage } = require(STAGE_PATH);

  const responded = [];
  const ctx = {
    params: {
      text: "producto bizcochuelo 50 unidades 20 pesos",
      businessId: "biz-1",
      actorUserId: "user-1",
      trace: { add: () => {}, toJSON: () => null },
      latency: { start: () => {}, end: () => {}, setMeta: () => {}, emit: () => {} },
      respond: async (body) => { responded.push(body); return {}; },
    },
    runSupervisor: async () => { throw new Error("Supervisor should not run when flag is off"); },
  };

  const result = await ownerAssistantStage.run(ctx);

  assert.equal(result, null, "Stage must return null when USE_OWNER_ASSISTANT is not set");
  assert.equal(responded.length, 0, "respond must not have been called");
});

// ── Test 7: Flag OFF=false → stage returns null ───────────────────────

test("ownerAssistantStage: USE_OWNER_ASSISTANT=false → stage returns null", async () => {
  process.env.USE_OWNER_ASSISTANT = "false";

  const captures = {};
  buildAdkMockForToolCall(captures, "create_product", { name: "x", price: 1, stock: null });
  installGeminiConfigMock();
  installCatalogMock();
  installCloudLoggerMock();

  delete Module._cache[STAGE_PATH];
  delete Module._cache[CONTEXT_PATH];
  delete Module._cache[MAPPER_PATH];
  clearOwnerAssistantCache();

  const { ownerAssistantStage } = require(STAGE_PATH);

  const ctx = {
    params: {
      text: "algo",
      businessId: "biz-1",
      actorUserId: "user-1",
      trace: { add: () => {}, toJSON: () => null },
      latency: { start: () => {}, end: () => {}, setMeta: () => {}, emit: () => {} },
      respond: async () => { throw new Error("respond must not be called"); },
    },
    runSupervisor: async () => { throw new Error("Supervisor should not run"); },
  };

  const result = await ownerAssistantStage.run(ctx);
  assert.equal(result, null);

  // Clean up
  delete process.env.USE_OWNER_ASSISTANT;
});
