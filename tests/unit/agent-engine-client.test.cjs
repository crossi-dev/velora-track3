// Tests para src/lib/adk/agent-engine-client.ts — TS bridge al Agent Engine
// deploy. Verifica el shape del request, gate por flag, fallback graceful.

process.env.AUTH_SECRET = process.env.AUTH_SECRET || "test-agent-engine-client-secret-32x";
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgresql://test:test@localhost:5432/test";

const assert = require("node:assert/strict");
const test = require("node:test");
const Module = require("node:module");
const path = require("node:path");

const SUT_PATH = path.resolve(__dirname, "../../src/lib/adk/agent-engine-client.ts");

// Stub google-auth-library — Node ESM resolves it; for our CJS test runtime
// we go via Module._load.
const origLoad = Module._load;
Module._load = function (request, parent, ...rest) {
  if (request === "google-auth-library") {
    return {
      GoogleAuth: class {
        async getClient() {
          return { async getAccessToken() { return { token: "fake-token" }; } };
        }
      },
    };
  }
  return origLoad.call(this, request, parent, ...rest);
};

function reload() {
  delete Module._cache[SUT_PATH];
  return require(SUT_PATH);
}

process.on("exit", () => { Module._load = origLoad; });

// ── Flag gating ──────────────────────────────────────────────────────────

test("isAgentEngineEnabled: false default", () => {
  delete process.env.USE_AGENT_ENGINE;
  delete process.env.AGENT_ENGINE_RESOURCE_NAME;
  const { isAgentEngineEnabled } = reload();
  assert.equal(isAgentEngineEnabled(), false);
});

test("isAgentEngineEnabled: false si flag on pero no resource name", () => {
  process.env.USE_AGENT_ENGINE = "true";
  delete process.env.AGENT_ENGINE_RESOURCE_NAME;
  const { isAgentEngineEnabled } = reload();
  assert.equal(isAgentEngineEnabled(), false);
  delete process.env.USE_AGENT_ENGINE;
});

test("isAgentEngineEnabled: true cuando flag + resource configurados", () => {
  process.env.USE_AGENT_ENGINE = "true";
  process.env.AGENT_ENGINE_RESOURCE_NAME = "projects/my-gcp-project/locations/us-central1/reasoningEngines/abc";
  const { isAgentEngineEnabled } = reload();
  assert.equal(isAgentEngineEnabled(), true);
  delete process.env.USE_AGENT_ENGINE;
  delete process.env.AGENT_ENGINE_RESOURCE_NAME;
});

// ── queryAgentEngine ─────────────────────────────────────────────────────

test("queryAgentEngine: null cuando flag off", async () => {
  delete process.env.USE_AGENT_ENGINE;
  const { queryAgentEngine } = reload();
  assert.equal(await queryAgentEngine({ input: "vendí 2" }), null);
});

test("queryAgentEngine: posts al endpoint :query con shape correcto", async () => {
  process.env.USE_AGENT_ENGINE = "true";
  process.env.AGENT_ENGINE_RESOURCE_NAME = "projects/my-gcp-project/locations/us-central1/reasoningEngines/abc";
  const origFetch = global.fetch;
  let captured = null;
  global.fetch = async (url, opts) => {
    captured = { url, body: JSON.parse(opts.body) };
    return {
      ok: true,
      async json() { return { output: { text: "Listo, registré la venta" } }; },
    };
  };
  const { queryAgentEngine } = reload();
  const out = await queryAgentEngine({
    input: "vendí 2 cubiertas",
    subAgent: "employee",
    sessionId: "biz-abc",
  });
  assert.equal(out.text, "Listo, registré la venta");
  assert.match(captured.url, /:query$/);
  assert.match(captured.url, /reasoningEngines\/abc/);
  assert.equal(captured.body.input.query, "vendí 2 cubiertas");
  assert.equal(captured.body.input.sub_agent, "employee");
  assert.equal(captured.body.input.session_id, "biz-abc");
  global.fetch = origFetch;
  delete process.env.USE_AGENT_ENGINE;
  delete process.env.AGENT_ENGINE_RESOURCE_NAME;
});

test("queryAgentEngine: 5xx → null sin throw", async () => {
  process.env.USE_AGENT_ENGINE = "true";
  process.env.AGENT_ENGINE_RESOURCE_NAME = "projects/my-gcp-project/locations/us-central1/reasoningEngines/abc";
  const origFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 503, async json() { return {}; } });
  const { queryAgentEngine } = reload();
  assert.equal(await queryAgentEngine({ input: "vendí 2" }), null);
  global.fetch = origFetch;
  delete process.env.USE_AGENT_ENGINE;
  delete process.env.AGENT_ENGINE_RESOURCE_NAME;
});

test("queryAgentEngine: response sin output → null", async () => {
  process.env.USE_AGENT_ENGINE = "true";
  process.env.AGENT_ENGINE_RESOURCE_NAME = "projects/my-gcp-project/locations/us-central1/reasoningEngines/abc";
  const origFetch = global.fetch;
  global.fetch = async () => ({ ok: true, async json() { return {}; } });
  const { queryAgentEngine } = reload();
  assert.equal(await queryAgentEngine({ input: "x" }), null);
  global.fetch = origFetch;
  delete process.env.USE_AGENT_ENGINE;
  delete process.env.AGENT_ENGINE_RESOURCE_NAME;
});

test("queryAgentEngine: input vacío → null sin fetch", async () => {
  process.env.USE_AGENT_ENGINE = "true";
  process.env.AGENT_ENGINE_RESOURCE_NAME = "projects/my-gcp-project/locations/us-central1/reasoningEngines/abc";
  const origFetch = global.fetch;
  let called = false;
  global.fetch = async () => { called = true; return { ok: true, async json() { return {}; } }; };
  const { queryAgentEngine } = reload();
  assert.equal(await queryAgentEngine({ input: "" }), null);
  assert.equal(called, false);
  global.fetch = origFetch;
  delete process.env.USE_AGENT_ENGINE;
  delete process.env.AGENT_ENGINE_RESOURCE_NAME;
});

test("queryAgentEngine: acepta output como string directo", async () => {
  process.env.USE_AGENT_ENGINE = "true";
  process.env.AGENT_ENGINE_RESOURCE_NAME = "projects/my-gcp-project/locations/us-central1/reasoningEngines/abc";
  const origFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    async json() { return { output: "respuesta plana" }; },
  });
  const { queryAgentEngine } = reload();
  const out = await queryAgentEngine({ input: "x" });
  assert.equal(out.text, "respuesta plana");
  global.fetch = origFetch;
  delete process.env.USE_AGENT_ENGINE;
  delete process.env.AGENT_ENGINE_RESOURCE_NAME;
});
