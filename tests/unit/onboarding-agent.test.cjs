// Unit tests for the OnboardingAgent pure logic:
//   - validateOutput: runtime contract enforcement on the LLM's JSON output
//   - buildOnboardingTurnPrompt: deterministic re-prompt catch-all
//   - OnboardingStateInputSchema: Zod validation for A2A inbound state
//
// We deliberately do NOT test the Vertex AI runner here — that path is
// integration-tested end-to-end via the live smoke loop against prod.

const assert = require("node:assert/strict");
const test = require("node:test");

const { validateOutput, validateRawOutput, ALLOWED_TOOLS } = require("../../src/lib/adk/onboarding-agent.ts");
const { ONBOARDING_AGENT_PROMPT } = require("../../src/lib/adk/onboarding-agent.prompt.ts");
const { buildOnboardingTurnPrompt } = require(
  "../../src/app/api/business-assistant/_lib/onboarding-fast-path.help-fallback.ts"
);
const { OnboardingStateInputSchema } = require(
  "../../src/app/api/agents/onboarding/jsonrpc/_lib/onboarding-state-schema.ts"
);

// ── validateOutput happy paths ─────────────────────────────────────────────

test("validateOutput: accepts a fully-formed result with actions and chips", () => {
  const out = validateOutput({
    answer: "Distribuidora Norte, anotado. ¿Cómo cobrás?",
    actions: [{ intent: "update_business_setup", data: { field: "businessName", value: "Distribuidora Norte" }, summary: "Nombre guardado" }],
    chips: { kind: "multi", options: [{ label: "Efectivo", value: "Efectivo" }] },
    matchedTurn: 1,
  });
  assert.equal(out.matchedTurn, 1);
  assert.equal(out.actions[0].intent, "update_business_setup");
  assert.equal(out.chips.kind, "multi");
});

test("validateOutput: accepts an empty actions array (conversational turn)", () => {
  const out = validateOutput({
    answer: "Te cuento: Velora conecta MP, ARCA, Andreani y manejás todo por chat. ¿Cómo se llama tu negocio?",
    actions: [],
    chips: null,
    matchedTurn: 1,
  });
  assert.equal(out.actions.length, 0);
  assert.equal(out.chips, null);
});

test("validateOutput: normalises missing chips field to null", () => {
  const out = validateOutput({
    answer: "Ok",
    actions: [],
    matchedTurn: 1,
  });
  assert.equal(out.chips, null);
});

// ── validateOutput rejection paths ─────────────────────────────────────────

test("validateOutput: rejects when output is not an object", () => {
  assert.throws(() => validateOutput("just a string"), /output is not an object/);
  assert.throws(() => validateOutput(null), /output is not an object/);
});

test("validateOutput: rejects missing or empty answer", () => {
  assert.throws(
    () => validateOutput({ actions: [], chips: null, matchedTurn: 1 }),
    /answer missing/,
  );
  assert.throws(
    () => validateOutput({ answer: "", actions: [], chips: null, matchedTurn: 1 }),
    /answer missing/,
  );
});

test("validateOutput: rejects when actions is not an array", () => {
  assert.throws(
    () => validateOutput({ answer: "x", actions: {}, chips: null, matchedTurn: 1 }),
    /actions is not an array/,
  );
});

test("validateOutput: rejects an action with an intent outside the allowlist", () => {
  // 'delete_user' is not in the OnboardingAgent allowlist. The supervisor or
  // a runaway model must NOT be able to slip arbitrary intents through here.
  assert.throws(
    () => validateOutput({
      answer: "x",
      actions: [{ intent: "delete_user", data: {} }],
      chips: null,
      matchedTurn: 1,
    }),
    /not in allowlist/,
  );
});

test("validateOutput: rejects an action with non-object data", () => {
  assert.throws(
    () => validateOutput({
      answer: "x",
      actions: [{ intent: "update_business_setup", data: "not-an-object" }],
      chips: null,
      matchedTurn: 1,
    }),
    /action data missing/,
  );
});

test("validateOutput: rejects an out-of-range matchedTurn (2 is removed; 99 invalid)", () => {
  for (const badTurn of [2, 4, 0, 15, 99, -1]) {
    assert.throws(
      () => validateOutput({ answer: "x", actions: [], chips: null, matchedTurn: badTurn }),
      /not allowed/,
      `expected turn ${badTurn} to be rejected`,
    );
  }
});

test("validateOutput: rejects a non-number matchedTurn", () => {
  assert.throws(
    () => validateOutput({ answer: "x", actions: [], chips: null, matchedTurn: "1" }),
    /not allowed/,
  );
});

// ── buildOnboardingTurnPrompt catch-all ────────────────────────────────────

test("buildOnboardingTurnPrompt T1: warm name question, no chips, no actions", () => {
  const r = buildOnboardingTurnPrompt(1, null, null);
  assert.equal(r.matchedTurn, 1);
  assert.match(r.answer, /c[óo]mo se llama tu negocio/i);
  assert.deepEqual(r.actions, []);
  assert.equal(r.chips, null);
});

test("buildOnboardingTurnPrompt T3: payment methods question with multi chips", () => {
  const r = buildOnboardingTurnPrompt(3, null, null);
  assert.equal(r.matchedTurn, 3);
  assert.match(r.answer, /c[óo]mo cobr[áa]s/i);
  assert.equal(r.chips?.kind, "multi");
});

test("buildOnboardingTurnPrompt T8: alias example included", () => {
  const r = buildOnboardingTurnPrompt(8, null, null);
  assert.equal(r.matchedTurn, 8);
  assert.match(r.answer, /alias bancario|cbu/i);
  assert.match(r.answer, /carlos\.rossi\.mp/i);
});

test("buildOnboardingTurnPrompt T6: includes the pending product name", () => {
  const r = buildOnboardingTurnPrompt(6, null, "Alfajor de Maicena");
  assert.equal(r.matchedTurn, 6);
  assert.match(r.answer, /Alfajor de Maicena/);
});

test("buildOnboardingTurnPrompt T6: falls back to generic 'el producto' when no name provided", () => {
  const r = buildOnboardingTurnPrompt(6, null, null);
  assert.match(r.answer, /el producto/);
});

test("buildOnboardingTurnPrompt T14: chip label uses the configured courier preference", () => {
  const r = buildOnboardingTurnPrompt(14, "OCA", null);
  assert.equal(r.matchedTurn, 14);
  // T14 dispatcher renders OCA in the chip label when courier=OCA.
  assert.equal(r.chips?.options?.[0]?.label, "Conectar OCA");
});

test("buildOnboardingTurnPrompt: actions are always empty (catch-all never persists)", () => {
  for (const turn of [1, 3, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]) {
    const r = buildOnboardingTurnPrompt(turn, "Andreani", "x");
    assert.deepEqual(
      r.actions,
      [],
      `catch-all at turn ${turn} must not emit any action`,
    );
  }
});

// ── OnboardingStateInputSchema (A2A inbound state Zod validation) ──────────

test("OnboardingStateInputSchema: accepts an empty object and fills all defaults", () => {
  const result = OnboardingStateInputSchema.safeParse({});
  assert.equal(result.success, true);
  assert.equal(result.data.businessNameSet, false);
  assert.equal(result.data.productCount, 0);
  assert.equal(result.data.customerCount, 0);
  assert.equal(result.data.transferAlias, null);
  assert.equal(result.data.pendingStockProduct, null);
});

test("OnboardingStateInputSchema: accepts a fully-formed valid state object", () => {
  const result = OnboardingStateInputSchema.safeParse({
    businessNameSet: true,
    paymentMethodsSet: true,
    paymentMethodsIncludeTransferencia: true,
    transferAlias: "mitienda.mp",
    transferAliasSet: true,
    postalCodeSet: true,
    courierPreferenceSet: true,
    courierPreference: "Andreani",
    whatsappPhoneSet: true,
    productCount: 5,
    pendingStockProduct: { productId: "prod-123", name: "Alfajor" },
    mercadoPagoSelected: true,
    mercadoPagoConnected: false,
    mercadoPagoOnboardingDeferred: false,
    customerCount: 3,
    customersOnboardingSkipped: false,
    arcaCertConnected: false,
    arcaOnboardingDeferred: true,
    courierCredentialsConnected: false,
    andreaniOnboardingDeferred: false,
  });
  assert.equal(result.success, true);
  assert.equal(result.data.productCount, 5);
  assert.equal(result.data.transferAlias, "mitienda.mp");
  assert.equal(result.data.pendingStockProduct?.name, "Alfajor");
});

test("OnboardingStateInputSchema: rejects when a boolean field receives a non-boolean", () => {
  // productCount: "cinco" is a string, not a number — should fail
  const result = OnboardingStateInputSchema.safeParse({
    businessNameSet: "yes",  // must be boolean, not string
  });
  assert.equal(result.success, false);
});

test("OnboardingStateInputSchema: rejects negative productCount", () => {
  const result = OnboardingStateInputSchema.safeParse({ productCount: -1 });
  assert.equal(result.success, false);
});

test("OnboardingStateInputSchema: rejects non-integer productCount", () => {
  const result = OnboardingStateInputSchema.safeParse({ productCount: 1.5 });
  assert.equal(result.success, false);
});

test("OnboardingStateInputSchema: rejects pendingStockProduct missing required fields", () => {
  // pendingStockProduct must have productId and name
  const result = OnboardingStateInputSchema.safeParse({
    pendingStockProduct: { name: "Alfajor" },  // missing productId
  });
  assert.equal(result.success, false);
});

test("OnboardingStateInputSchema: accepts null for pendingStockProduct", () => {
  const result = OnboardingStateInputSchema.safeParse({ pendingStockProduct: null });
  assert.equal(result.success, true);
  assert.equal(result.data.pendingStockProduct, null);
});

test("OnboardingStateInputSchema: rejects an array (malformed state top-level)", () => {
  const result = OnboardingStateInputSchema.safeParse([]);
  assert.equal(result.success, false);
});

test("OnboardingStateInputSchema: rejects a string (malformed state top-level)", () => {
  const result = OnboardingStateInputSchema.safeParse("corrupted");
  assert.equal(result.success, false);
});

// ── CRITICAL #1 regression — buoy contract app:* key parity ───────────────
// Ensures the BUOY GUIDANCE CONTRACT section uses the exact keys injected by
// buildCapabilityStateDelta() in supervisor-runner.capabilities.ts.
// Wrong keys (e.g. "app:mercadopago") are always undefined in session.state →
// buoy never surfaces correct next-best-step.

test("buoy contract: prompt contains app:mercadopago_connected (correct suffixed key)", () => {
  assert.ok(
    ONBOARDING_AGENT_PROMPT.includes("app:mercadopago_connected"),
    "ONBOARDING_AGENT_PROMPT must contain the correct key app:mercadopago_connected",
  );
});

test("buoy contract: prompt does NOT contain bare app:mercadopago (wrong key)", () => {
  // The correct key is app:mercadopago_connected; bare app:mercadopago should not appear
  // anywhere in the prompt (it would always read as undefined in session.state).
  const bareOccurrences = (ONBOARDING_AGENT_PROMPT.match(/app:mercadopago(?!_)/g) ?? []).length;
  assert.equal(
    bareOccurrences,
    0,
    `ONBOARDING_AGENT_PROMPT must not contain bare 'app:mercadopago' (found ${bareOccurrences} occurrence(s))`,
  );
});

test("buoy contract: prompt contains app:whatsapp_phone_set (correct suffixed key)", () => {
  assert.ok(
    ONBOARDING_AGENT_PROMPT.includes("app:whatsapp_phone_set"),
    "ONBOARDING_AGENT_PROMPT must contain the correct key app:whatsapp_phone_set",
  );
});

test("buoy contract: prompt contains app:arca_connected (correct suffixed key)", () => {
  assert.ok(
    ONBOARDING_AGENT_PROMPT.includes("app:arca_connected"),
    "ONBOARDING_AGENT_PROMPT must contain the correct key app:arca_connected",
  );
});

test("buoy contract: prompt contains app:andreani_connected (correct suffixed key)", () => {
  assert.ok(
    ONBOARDING_AGENT_PROMPT.includes("app:andreani_connected"),
    "ONBOARDING_AGENT_PROMPT must contain the correct key app:andreani_connected",
  );
});

test("buoy contract: prompt contains app:whatsapp_business_connected (correct suffixed key)", () => {
  assert.ok(
    ONBOARDING_AGENT_PROMPT.includes("app:whatsapp_business_connected"),
    "ONBOARDING_AGENT_PROMPT must contain the correct key app:whatsapp_business_connected",
  );
});

// ── Onboarding v3 (2026-06-04) — agent owns name + catalog ONLY ──
// Payment / shipping / WhatsApp moved to the SetupChecklist dashboard card.
// The agent's allowlist must contain exactly save_business_name + import_catalog,
// and must REJECT the removed connect_* tools (guard against re-introduction).

test("ALLOWED_TOOLS is exactly {save_business_name, import_catalog}", () => {
  assert.ok(ALLOWED_TOOLS.has("save_business_name"), "must allow save_business_name");
  assert.ok(ALLOWED_TOOLS.has("import_catalog"), "must allow import_catalog");
  assert.equal(ALLOWED_TOOLS.size, 2, `expected exactly 2 tools, got ${ALLOWED_TOOLS.size}`);
});

test("validateRawOutput: rejects connect_* tools (removed in v3 — services live in the card)", () => {
  for (const tool of ["connect_whatsapp_business", "connect_payment_method", "connect_shipping_provider"]) {
    assert.throws(
      () => validateRawOutput({ answer: "ok", tool_name: tool, tool_args: {}, chips: null }),
      /not in allowlist/,
      `${tool} must be rejected — it was removed from the onboarding agent in v3`,
    );
  }
});

test("validateRawOutput: rejects tool_name not in allowlist (guard still active)", () => {
  // validateRawOutput must still reject unknown tool names (regression guard).
  assert.throws(
    () => validateRawOutput({
      answer: "Procesando...",
      tool_name: "delete_business",
      tool_args: {},
      chips: null,
    }),
    /not in allowlist/,
  );
});
