"use strict";

// Unit tests for CapabilityToolset (src/lib/adk/capability-toolset.ts).
//
// Strategy: load the module with real @google/adk (BaseToolset is available in
// the installed package). Build minimal fake BaseTool + ReadonlyContext objects
// to drive the filtering logic without hitting Vertex AI.
//
// Covers:
//   1. All capabilities true → all tools returned.
//   2. Only mercadopago connected → call_payments included; call_logistica excluded.
//   3. Only alias_cbu connected → call_payments included (OR gate).
//   4. All capabilities false → call_payments + call_logistica + call_contador excluded.
//   5. All capabilities false → non-gated tools (call_ventas, call_communications) always included.
//   6. Unknown tool (no TOOL_GATE entry) → always returned regardless of state.
//   7. Empty tool list → returns empty array.

const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");
const Module = require("node:module");

// ── Module loading ────────────────────────────────────────────────────────

const TOOLSET_PATH = path.resolve(__dirname, "../../src/lib/adk/capability-toolset.ts");
// Resolve the real @google/adk path so we can restore it if another test mocked it.
const ADK_PATH = require.resolve("@google/adk");

function loadToolsetModule() {
  // Restore real @google/adk if it was mocked by a previous test in run-all.cjs
  // (e.g. adk-wrappers.test.cjs or agent-engine-*.test.cjs replace the module
  // cache entry with a stub that omits BaseToolset, causing "extends undefined").
  // Clearing the cache entry forces Node to re-require the real package.
  delete Module._cache[ADK_PATH];
  // Clear capability-toolset.ts so it re-requires the (now-real) @google/adk.
  delete Module._cache[TOOLSET_PATH];
  // ts-node transpiles this via the register hook from run-all.cjs / register.cjs.
  return require(TOOLSET_PATH);
}

// ── Fake builders ─────────────────────────────────────────────────────────

/**
 * Creates a minimal fake BaseTool with the given name.
 * BaseTool requires a `name` property; the other fields are not checked by CapabilityToolset.
 */
function fakeTool(name) {
  return { name, description: `fake-${name}` };
}

/**
 * Creates a minimal fake ReadonlyContext with the given state map.
 * Mirrors the ADK State.get(key, defaultValue) interface.
 */
function fakeContext(stateMap = {}) {
  return {
    state: {
      get(key, defaultValue = undefined) {
        return key in stateMap ? stateMap[key] : defaultValue;
      },
    },
  };
}

/** Full capability state — all providers connected. */
function fullCaps() {
  return {
    "app:mercadopago_connected": true,
    "app:alias_cbu_set": true,
    "app:andreani_connected": true,
    "app:arca_connected": true,
    "app:whatsapp_business_connected": true,
    "app:whatsapp_phone_set": true,
  };
}

/** Zero capability state — no providers connected. */
function zeroCaps() {
  return {
    "app:mercadopago_connected": false,
    "app:alias_cbu_set": false,
    "app:andreani_connected": false,
    "app:arca_connected": false,
    "app:whatsapp_business_connected": false,
    "app:whatsapp_phone_set": false,
  };
}

// ── Full tool list used across tests ──────────────────────────────────────

const FULL_TOOLS = [
  fakeTool("call_payments_agent"),
  fakeTool("call_logistica_agent"),
  fakeTool("call_contador_agent"),
  fakeTool("call_ventas_agent"),
  fakeTool("call_communications_agent"),
  fakeTool("check_stock"),
  fakeTool("business_query"),
  fakeTool("create_payment_link"),
  fakeTool("quote_shipping"),
];

// ── Tests ─────────────────────────────────────────────────────────────────

test("all capabilities true → all tools returned", async () => {
  const { CapabilityToolset } = loadToolsetModule();
  const toolset = new CapabilityToolset(FULL_TOOLS);
  const ctx = fakeContext(fullCaps());

  const result = await toolset.getTools(ctx);

  assert.equal(result.length, FULL_TOOLS.length);
  const names = result.map((t) => t.name);
  assert.ok(names.includes("call_payments_agent"));
  assert.ok(names.includes("call_logistica_agent"));
  assert.ok(names.includes("call_contador_agent"));
  assert.ok(names.includes("call_ventas_agent"));
  assert.ok(names.includes("call_communications_agent"));
});

test("only mercadopago → call_payments included; call_logistica and call_contador excluded", async () => {
  const { CapabilityToolset } = loadToolsetModule();
  const toolset = new CapabilityToolset(FULL_TOOLS);
  const ctx = fakeContext({ ...zeroCaps(), "app:mercadopago_connected": true });

  const result = await toolset.getTools(ctx);
  const names = result.map((t) => t.name);

  assert.ok(names.includes("call_payments_agent"), "payments must be included (mercadopago connected)");
  assert.ok(!names.includes("call_logistica_agent"), "logistica must be excluded (no andreani)");
  assert.ok(!names.includes("call_contador_agent"), "contador must be excluded (no arca)");
  // Always-on tools must survive.
  assert.ok(names.includes("call_ventas_agent"));
  assert.ok(names.includes("call_communications_agent"));
});

test("alias_cbu only → call_payments included (OR gate with mercadopago)", async () => {
  const { CapabilityToolset } = loadToolsetModule();
  const toolset = new CapabilityToolset(FULL_TOOLS);
  const ctx = fakeContext({ ...zeroCaps(), "app:alias_cbu_set": true });

  const result = await toolset.getTools(ctx);
  const names = result.map((t) => t.name);

  assert.ok(names.includes("call_payments_agent"), "alias_cbu alone must gate in payments");
});

test("all capabilities false → call_payments + call_logistica + call_contador excluded", async () => {
  const { CapabilityToolset } = loadToolsetModule();
  const toolset = new CapabilityToolset(FULL_TOOLS);
  const ctx = fakeContext(zeroCaps());

  const result = await toolset.getTools(ctx);
  const names = result.map((t) => t.name);

  assert.ok(!names.includes("call_payments_agent"), "payments must be gated out");
  assert.ok(!names.includes("call_logistica_agent"), "logistica must be gated out");
  assert.ok(!names.includes("call_contador_agent"), "contador must be gated out");
});

test("all capabilities false → non-gated tools always included", async () => {
  const { CapabilityToolset } = loadToolsetModule();
  const toolset = new CapabilityToolset(FULL_TOOLS);
  const ctx = fakeContext(zeroCaps());

  const result = await toolset.getTools(ctx);
  const names = result.map((t) => t.name);

  assert.ok(names.includes("call_ventas_agent"), "ventas must always be included");
  assert.ok(names.includes("call_communications_agent"), "communications must always be included");
  assert.ok(names.includes("check_stock"), "check_stock must always be included");
  assert.ok(names.includes("business_query"), "business_query must always be included");
});

test("unknown tool name (no TOOL_GATE) → always returned regardless of state", async () => {
  const { CapabilityToolset } = loadToolsetModule();
  const unknownTool = fakeTool("some_future_tool_xyz");
  const toolset = new CapabilityToolset([unknownTool]);
  const ctx = fakeContext(zeroCaps());

  const result = await toolset.getTools(ctx);
  assert.equal(result.length, 1);
  assert.equal(result[0].name, "some_future_tool_xyz");
});

test("empty tool list → returns empty array", async () => {
  const { CapabilityToolset } = loadToolsetModule();
  const toolset = new CapabilityToolset([]);
  const ctx = fakeContext(zeroCaps());

  const result = await toolset.getTools(ctx);
  assert.deepEqual(result, []);
});

// ── Mock-mode gating tests (CapabilityToolset vs *_MOCK_MODE fix) ─────────

test("mercadopago_mock=true + no real creds → call_payments_agent and create_payment_link exposed", async () => {
  const { CapabilityToolset } = loadToolsetModule();
  const toolset = new CapabilityToolset(FULL_TOOLS);
  // No real MP connection, no alias_cbu — only the mock flag is set.
  const ctx = fakeContext({ ...zeroCaps(), "app:mercadopago_mock": true });

  const result = await toolset.getTools(ctx);
  const names = result.map((t) => t.name);

  assert.ok(names.includes("call_payments_agent"), "mock flag must expose call_payments_agent");
  assert.ok(names.includes("create_payment_link"), "mock flag must expose create_payment_link");
  assert.ok(!names.includes("call_logistica_agent"), "logistica still excluded (no andreani)");
  assert.ok(!names.includes("call_contador_agent"), "contador still excluded (no arca)");
});

test("mercadopago_mock=false + no real creds → call_payments_agent and create_payment_link hidden", async () => {
  const { CapabilityToolset } = loadToolsetModule();
  const toolset = new CapabilityToolset(FULL_TOOLS);
  const ctx = fakeContext(zeroCaps());

  const result = await toolset.getTools(ctx);
  const names = result.map((t) => t.name);

  assert.ok(!names.includes("call_payments_agent"), "payments hidden when no creds and mock off");
  assert.ok(!names.includes("create_payment_link"), "create_payment_link hidden when no creds and mock off");
});

test("andreani_mock=true + no real creds → quote_shipping and call_logistica_agent exposed", async () => {
  const { CapabilityToolset } = loadToolsetModule();
  const toolset = new CapabilityToolset(FULL_TOOLS);
  const ctx = fakeContext({ ...zeroCaps(), "app:andreani_mock": true });

  const result = await toolset.getTools(ctx);
  const names = result.map((t) => t.name);

  assert.ok(names.includes("call_logistica_agent"), "mock flag must expose call_logistica_agent");
  assert.ok(names.includes("quote_shipping"), "mock flag must expose quote_shipping");
  assert.ok(!names.includes("call_payments_agent"), "payments still excluded (no mp creds or mock)");
});

test("andreani_mock=false + no real creds → quote_shipping and call_logistica_agent hidden", async () => {
  const { CapabilityToolset } = loadToolsetModule();
  const toolset = new CapabilityToolset(FULL_TOOLS);
  const ctx = fakeContext(zeroCaps());

  const result = await toolset.getTools(ctx);
  const names = result.map((t) => t.name);

  assert.ok(!names.includes("call_logistica_agent"), "logistica hidden when no creds and mock off");
  assert.ok(!names.includes("quote_shipping"), "quote_shipping hidden when no creds and mock off");
});
