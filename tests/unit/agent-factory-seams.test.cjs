// Tests for src/lib/adk/agent-factory.seams.ts + createAdkAgent seam wiring.
// Covers: P2 buildProhibitionsBlock, P3 buildHitlBlock, P1 guardMoneyAmount,
//         P6 agentEvalRegistry, factory integration (prohibitions / HITL / eval).

const assert = require("node:assert/strict");
const test = require("node:test");
const Module = require("node:module");
const path = require("node:path");

const SEAMS_PATH = path.resolve(__dirname, "../../src/lib/adk/agent-factory.seams.ts");
const FACTORY_PATH = path.resolve(__dirname, "../../src/lib/adk/agent-factory.ts");

// ── Stubs ──────────────────────────────────────────────────────────────────────
let logCalls = [];
const origLoad = Module._load;
Module._load = function (request, parent, ...rest) {
  if (request === "@/lib/cloud-logger") return { cloudLog: (e) => { logCalls.push(e); } };
  if (request === "server-only") return {};
  return origLoad.call(this, request, parent, ...rest);
};

let lastAgentConfig = null;
const adkPath = require.resolve("@google/adk");
Module._cache[adkPath] = {
  id: adkPath, filename: adkPath, loaded: true,
  exports: {
    Agent: class FakeAgent { constructor(cfg) { lastAgentConfig = cfg; } },
    // Base class extended by src/lib/adk/engine-adapter.ts (VeloraEngineAdapter).
    // This mock stays cached on Module._cache after this file loads (never
    // restored), so any later require of engine-adapter.ts still needs a real
    // constructor here or `class ... extends BaseLlm` throws at load time.
    BaseLlm: class {},
    BaseTool: class {}, Gemini: class {}, InMemorySessionService: class {},
    BaseSessionService: class {}, createEvent: (e) => e, isFinalResponse: () => true,
    getFunctionCalls: () => [], getFunctionResponses: () => [],
    InMemoryRunner: class {}, Runner: class {}, BaseToolset: class {},
  },
};
process.on("exit", () => { Module._load = origLoad; });

function reloadSeams() {
  delete Module._cache[SEAMS_PATH];
  return require(SEAMS_PATH);
}
function reloadFactory() {
  delete Module._cache[SEAMS_PATH];
  delete Module._cache[FACTORY_PATH];
  logCalls = []; lastAgentConfig = null;
  return require(FACTORY_PATH);
}

// ── P2  buildProhibitionsBlock ─────────────────────────────────────────────────

test("buildProhibitionsBlock: formats numbered list with header", () => {
  const { buildProhibitionsBlock } = reloadSeams();
  const r = buildProhibitionsBlock(["Nunca inventes precios.", "Nunca ejecutes sin datos."]);
  assert.ok(r.startsWith("PROHIBICIONES (no negociables):"), "header present");
  assert.ok(r.includes("1. Nunca inventes precios."), "first item numbered");
  assert.ok(r.includes("2. Nunca ejecutes sin datos."), "second item numbered");
});

test("buildProhibitionsBlock: returns empty string for empty array", () => {
  const { buildProhibitionsBlock } = reloadSeams();
  assert.equal(buildProhibitionsBlock([]), "");
});

test("buildProhibitionsBlock: trims each entry", () => {
  const { buildProhibitionsBlock } = reloadSeams();
  const r = buildProhibitionsBlock(["  Nunca inventar.  "]);
  assert.ok(r.includes("1. Nunca inventar."), "entry trimmed");
  assert.ok(!r.includes("  Nunca"), "no leading spaces");
});

// ── P3  buildHitlBlock ────────────────────────────────────────────────────────

test("buildHitlBlock: contains draft + confirmation + cancel keywords", () => {
  const { buildHitlBlock } = reloadSeams();
  const r = buildHitlBlock();
  assert.ok(r.includes("BORRADOR") || r.includes("borrador"), "draft keyword present");
  assert.ok(r.includes("Confirmás") || r.includes("confirmás"), "confirmation keyword");
  assert.ok(r.includes("cancelá") || r.includes("cancel"), "cancel on no-confirm");
  assert.ok(r.length > 50, "non-trivial block");
});

test("buildHitlBlock: deterministic", () => {
  const { buildHitlBlock } = reloadSeams();
  assert.equal(buildHitlBlock(), buildHitlBlock());
});

// ── P1  guardMoneyAmount ──────────────────────────────────────────────────────

test("guardMoneyAmount: DB when LLM is null", () => {
  const { guardMoneyAmount } = reloadSeams();
  const r = guardMoneyAmount({ llmAmount: null, dbAmount: 1500, rawUserText: "3 filtros" });
  assert.equal(r.amount, 1500); assert.equal(r.usedDb, true); assert.equal(r.usedLlm, false);
});

test("guardMoneyAmount: DB when LLM amount not in user text", () => {
  const { guardMoneyAmount } = reloadSeams();
  const r = guardMoneyAmount({ llmAmount: 2000, dbAmount: 1500, rawUserText: "vendé 2 filtros a María" });
  assert.equal(r.amount, 1500, "DB wins when LLM invented the price");
  assert.equal(r.usedLlm, false);
});

test("guardMoneyAmount: LLM accepted when user typed the exact amount", () => {
  const { guardMoneyAmount } = reloadSeams();
  const r = guardMoneyAmount({ llmAmount: 1800, dbAmount: 1500, rawUserText: "vendé a $1800 a Juan" });
  assert.equal(r.amount, 1800, "user-dictated price accepted");
  assert.equal(r.usedLlm, true); assert.equal(r.usedDb, false);
});

test("guardMoneyAmount: LLM matches DB → returns DB path", () => {
  const { guardMoneyAmount } = reloadSeams();
  const r = guardMoneyAmount({ llmAmount: 1500, dbAmount: 1500, rawUserText: "2 filtros" });
  assert.equal(r.amount, 1500); assert.equal(r.usedDb, true);
});

test("guardMoneyAmount: safe with empty rawUserText", () => {
  const { guardMoneyAmount } = reloadSeams();
  const r = guardMoneyAmount({ llmAmount: 500, dbAmount: 400, rawUserText: "" });
  assert.equal(r.amount, 400); assert.equal(r.usedDb, true);
});

test("guardMoneyAmount: safe with null rawUserText", () => {
  const { guardMoneyAmount } = reloadSeams();
  const r = guardMoneyAmount({ llmAmount: 500, dbAmount: 400, rawUserText: null });
  assert.equal(r.amount, 400);
});

test("guardMoneyAmount: rejects negative LLM amount", () => {
  const { guardMoneyAmount } = reloadSeams();
  const r = guardMoneyAmount({ llmAmount: -100, dbAmount: 800, rawUserText: "normal" });
  assert.equal(r.amount, 800); assert.equal(r.usedDb, true);
});

test("guardMoneyAmount: detects $ prefix in user text", () => {
  const { guardMoneyAmount } = reloadSeams();
  const r = guardMoneyAmount({ llmAmount: 3500, dbAmount: 1500, rawUserText: "mandá $3500 hoy" });
  assert.equal(r.amount, 3500); assert.equal(r.usedLlm, true);
});

// ── H-3 regression tests (qty exclusion + % bypass + substring false-positive) ─
// These three cases took 3 JD rounds to close on the H-3 guard. The shared
// user-typed-amount.ts module must pass all of them — confirmed below.

test("guardMoneyAmount regression: qty==llmAmount → must use DB (16x overcharge guard)", () => {
  // "vendé 2500 alfajores" — 2500 is the sale quantity.
  // LLM copies qty into the price field (llmAmount=2500). Without qty exclusion,
  // token 2500 matches → guard would wrongly honour a hallucinated price.
  // Correct: qty=2500 is excluded → no match → DB price 150 wins.
  const { guardMoneyAmount } = reloadSeams();
  const r = guardMoneyAmount({
    llmAmount: 2500,
    dbAmount: 150,
    rawUserText: "vendé 2500 alfajores",
    qty: 2500,
  });
  assert.equal(r.amount, 150, "qty token must not be read as a price — DB wins");
  assert.equal(r.usedLlm, false, "usedLlm must be false when qty==llmAmount");
  assert.equal(r.usedDb, true);
});

test("guardMoneyAmount regression: percentage in text → must use DB (% bypass)", () => {
  // "10% descuento" — 10 is a percentage, not a price.
  // The old .includes() approach would match "10" inside "10%descuento" (after
  // stripping spaces/dots/commas). Correct: % suffix skipped → no match → DB wins.
  const { guardMoneyAmount } = reloadSeams();
  const r = guardMoneyAmount({
    llmAmount: 10,
    dbAmount: 150,
    rawUserText: "vendé con 10% descuento",
  });
  assert.equal(r.amount, 150, "percentage token must not be read as a price — DB wins");
  assert.equal(r.usedLlm, false, "usedLlm must be false for percentage token");
  assert.equal(r.usedDb, true);
});

test("guardMoneyAmount regression: substring false-positive → must use DB (no partial match)", () => {
  // llmAmount=1 with text "vendé 12 tuercas". The old .includes("1") approach
  // would match "1" inside "12", wrongly accepting a hallucinated price of 1.
  // Correct: token 12 != 1 (exact value comparison) → no match → DB wins.
  const { guardMoneyAmount } = reloadSeams();
  const r = guardMoneyAmount({
    llmAmount: 1,
    dbAmount: 800,
    rawUserText: "vendé 12 tuercas",
    qty: 12,
  });
  assert.equal(r.amount, 800, "substring '1' inside '12' must not match — DB wins");
  assert.equal(r.usedLlm, false, "usedLlm must be false for substring non-match");
  assert.equal(r.usedDb, true);
});

// ── P6  agentEvalRegistry ─────────────────────────────────────────────────────

test("registerAgentEval: stores and retrieves mapping", () => {
  const { registerAgentEval, agentEvalRegistry } = reloadSeams();
  agentEvalRegistry.clear();
  registerAgentEval("velora_ventas_agent", "tests/eval/ventas-agent.evalset.json");
  assert.equal(agentEvalRegistry.get("velora_ventas_agent"), "tests/eval/ventas-agent.evalset.json");
});

test("registerAgentEval: last registration wins", () => {
  const { registerAgentEval, agentEvalRegistry } = reloadSeams();
  agentEvalRegistry.clear();
  registerAgentEval("velora_fiscal_agent", "tests/eval/fiscal-v1.evalset.json");
  registerAgentEval("velora_fiscal_agent", "tests/eval/fiscal-v2.evalset.json");
  assert.equal(agentEvalRegistry.get("velora_fiscal_agent"), "tests/eval/fiscal-v2.evalset.json");
});

// ── Factory integration ───────────────────────────────────────────────────────

test("createAdkAgent + prohibitions: PROHIBICIONES prepended before base", () => {
  const { createAdkAgent } = reloadFactory();
  createAdkAgent({
    name: "test_p2_agent", model: {}, instruction: "Base instruction.",
    prohibitions: ["Nunca inventes.", "Solo catálogo."],
  });
  const text = lastAgentConfig.instruction();
  const pi = text.indexOf("PROHIBICIONES"), bi = text.indexOf("Base instruction.");
  assert.ok(pi !== -1 && bi !== -1 && pi < bi, "PROHIBICIONES before base");
  assert.ok(text.includes("1. Nunca inventes."), "first prohibition numbered");
  assert.ok(text.includes("2. Solo catálogo."), "second prohibition numbered");
});

test("createAdkAgent + requiresOwnerApproval: HITL appended after base", () => {
  const { createAdkAgent } = reloadFactory();
  createAdkAgent({ name: "test_p3_agent", model: {}, instruction: "Base.", requiresOwnerApproval: true });
  const text = lastAgentConfig.instruction();
  const bi = text.indexOf("Base."), hi = text.indexOf("FLUJO OBLIGATORIO");
  assert.ok(hi !== -1 && bi < hi, "HITL appended after base instruction");
  assert.ok(text.includes("Confirmás"), "confirmation prompt present");
});

test("createAdkAgent + both seams: PROHIBICIONES → base → HITL order", () => {
  const { createAdkAgent } = reloadFactory();
  createAdkAgent({
    name: "test_both", model: {}, instruction: "Base.",
    prohibitions: ["Un ejemplo."], requiresOwnerApproval: true,
  });
  const text = lastAgentConfig.instruction();
  const p = text.indexOf("PROHIBICIONES"), b = text.indexOf("Base."), h = text.indexOf("FLUJO OBLIGATORIO");
  assert.ok(p < b && b < h, "correct order: PROHIBICIONES → base → HITL");
});

test("createAdkAgent without seams: instruction unchanged (backward compat)", () => {
  const { createAdkAgent } = reloadFactory();
  createAdkAgent({ name: "plain_agent", model: {}, instruction: "Plain only." });
  assert.equal(lastAgentConfig.instruction(), "Plain only.", "no extra content added");
});

test("createAdkAgent + evalDataset: registered in agentEvalRegistry", () => {
  const { createAdkAgent, agentEvalRegistry } = reloadFactory();
  agentEvalRegistry.clear();
  createAdkAgent({ name: "eval_agent", model: {}, instruction: "x.", evalDataset: "tests/eval/eval-agent.evalset.json" });
  assert.equal(agentEvalRegistry.get("eval_agent"), "tests/eval/eval-agent.evalset.json");
});

test("createAdkAgent without evalDataset: no registry entry", () => {
  const { createAdkAgent, agentEvalRegistry } = reloadFactory();
  agentEvalRegistry.clear();
  createAdkAgent({ name: "no_eval", model: {}, instruction: "x." });
  assert.equal(agentEvalRegistry.get("no_eval"), undefined);
});
