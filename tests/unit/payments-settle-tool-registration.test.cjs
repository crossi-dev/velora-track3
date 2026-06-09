// Unit tests — payments-settle-tool registration + customer-path price isolation.
//
// Covers:
//   1. settle_promesa_payment tool is registered in the Payments ADK agent
//      (createPaymentsAgent tools array includes it).
//   2. settle_promesa_payment tool is callable and rejects amount=0 at the
//      tool level.
//   3. Customer-path A2A message does NOT contain "precio_unitario=" so the
//      Payments LLM cannot forward a stale cart price as unitPriceOverride.
//
// DB-backed settle use-case flows are integration / phase4 tests.

"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  clearMockModules,
  resetSourceModules,
  setMockModule,
} = require("../phase4/module-hooks.cjs");

// ── Shared mock factories ─────────────────────────────────────────────────────

function makeCloudLoggerMock() {
  return { cloudLog: () => {} };
}

function makePrismaMock() {
  return { prisma: {} };
}

function makeA2AMock() {
  return {
    sendMessage: async () => { throw new Error("should not be called in unit tests"); },
    A2AClientError: class A2AClientError extends Error {},
  };
}

// Loads the Payments ADK agent with all heavy deps stubbed.
function loadPaymentsAgent() {
  resetSourceModules();
  clearMockModules();
  setMockModule("@/lib/prisma", makePrismaMock());
  setMockModule("@/lib/cloud-logger", makeCloudLoggerMock());
  setMockModule("@/lib/a2a-client", makeA2AMock());
  setMockModule("@/lib/agent-identity", { signAgentAssertion: () => null });
  setMockModule("@/app/api/a2a/jsonrpc/_lib/handle-rpc", { deriveA2AKey: () => "key" });
  setMockModule("@/lib/adk/gemini-config", {
    getAdkPaymentsModel: () => ({ kind: "gemini-flash-mock" }),
  });
  setMockModule("@google/adk", {
    Agent: class FakeAgent {
      constructor(cfg) { this.cfg = cfg; }
    },
    FunctionTool: class FakeFunctionTool {
      constructor(cfg) { this.cfg = cfg; this.name = cfg.name; }
    },
  });
  // Stub the payment-link use-case so loading the agent does not hit DB.
  setMockModule("@/app/api/payment-intents/_lib/payment-intent-link-use-case", {
    createPaymentLinkIntentUseCase: async () => ({ outcome: "created", paymentIntentId: "pi-test-001" }),
  });
  setMockModule("./payment-provider", {
    getPaymentProvider: async () => ({
      createCollection: async () => ({ paymentIntentId: "pi-test-001", amountARS: 0, checkoutUrl: "https://mp.com/pay", status: "pending", currency: "ARS" }),
      getStatus: async () => ({ paymentIntentId: "pi-test-001", status: "pending", currency: "ARS" }),
    }),
  });
  // Stub settle use-case — registration test does not exercise the use-case.
  setMockModule("@/app/api/payment-intents/_lib/settle-promesa-use-case", {
    settlePromesaUseCase: async () => ({ outcome: "settled", cashMovementId: "cm-001", settledAt: new Date() }),
  });
  return require("../../src/app/api/agents/payments/jsonrpc/_lib/adk-payments-agent.ts");
}

// Loads settle tool directly with its use-case stubbed.
function loadSettleTool({ settleResult }) {
  resetSourceModules();
  clearMockModules();
  setMockModule("@/lib/cloud-logger", makeCloudLoggerMock());
  setMockModule("@/app/api/payment-intents/_lib/settle-promesa-use-case", {
    settlePromesaUseCase: async () => settleResult,
  });
  setMockModule("@google/adk", {
    FunctionTool: class FakeFunctionTool {
      constructor(cfg) { this.cfg = cfg; this.name = cfg.name; this._execute = cfg.execute; }
      async execute(...args) { return this._execute(...args); }
    },
  });
  return require("../../src/app/api/agents/payments/jsonrpc/_lib/payments-settle-tool.ts");
}

// Loads the customer checkout tool with all heavy deps stubbed.
function loadCheckoutTools() {
  resetSourceModules();
  clearMockModules();
  setMockModule("@/lib/cloud-logger", makeCloudLoggerMock());
  setMockModule("@/lib/a2a-client", makeA2AMock());
  setMockModule("@/lib/agent-identity", { signAgentAssertion: () => null });
  setMockModule("@/app/api/a2a/jsonrpc/_lib/handle-rpc", { deriveA2AKey: () => "key" });
  setMockModule("@/lib/agent-timeouts", { PAYMENTS_AGENT_TIMEOUT_MS: 65000 });
  setMockModule("@/lib/shipping-quote", { resolveShippingQuote: async () => ({ ok: false, reason: "missing_destination_postal_code" }) });
  // customer-agent-tools-order is a sibling — load through normal module resolution.
  setMockModule("@google/adk", {
    FunctionTool: class FakeFunctionTool {
      constructor(cfg) { this.cfg = cfg; this.name = cfg.name; this._execute = cfg.execute; }
      async execute(...args) { return this._execute(...args); }
    },
  });
  setMockModule("@/lib/prisma", {
    prisma: {
      product: {
        findFirst: async () => ({
          id: "prod-001", name: "Alfajor Triple", price: 500, quantity: 100, businessId: "biz-001",
        }),
      },
    },
  });
  return require("../../src/lib/adk/customer-agent-tools-checkout.ts");
}

// ── 1. settle_promesa_payment registered in the Payments ADK agent ────────────

test("Payments ADK agent: settle_promesa_payment tool is registered", () => {
  const { createPaymentsAgent } = loadPaymentsAgent();
  // The ADK agent uses createAdkAgent which instantiates FakeAgent in our mock.
  // We need to inspect the tools array passed to it.
  // Patch createAdkAgent to capture the config.
  let capturedConfig = null;
  const agentMod = require("../../src/app/api/agents/payments/jsonrpc/_lib/adk-payments-agent.ts");
  // createPaymentsAgent is the export; we cannot intercept createAdkAgent easily
  // without re-loading. Instead, load the agent-factory and capture.
  resetSourceModules();
  clearMockModules();
  setMockModule("@/lib/prisma", makePrismaMock());
  setMockModule("@/lib/cloud-logger", makeCloudLoggerMock());
  setMockModule("@/lib/a2a-client", makeA2AMock());
  setMockModule("@/lib/agent-identity", { signAgentAssertion: () => null });
  setMockModule("@/app/api/a2a/jsonrpc/_lib/handle-rpc", { deriveA2AKey: () => "key" });
  setMockModule("@/lib/adk/gemini-config", {
    getAdkPaymentsModel: () => ({ kind: "gemini-flash-mock" }),
  });
  setMockModule("@google/adk", {
    Agent: class FakeAgent { constructor(cfg) { this.cfg = cfg; } },
    FunctionTool: class FakeFunctionTool { constructor(cfg) { this.cfg = cfg; this.name = cfg.name; } },
  });
  setMockModule("@/app/api/payment-intents/_lib/payment-intent-link-use-case", {
    createPaymentLinkIntentUseCase: async () => ({ outcome: "created", paymentIntentId: "pi-test-001" }),
  });
  setMockModule("./payment-provider", {
    getPaymentProvider: async () => ({}),
  });
  setMockModule("@/app/api/payment-intents/_lib/settle-promesa-use-case", {
    settlePromesaUseCase: async () => ({ outcome: "settled", cashMovementId: "cm-001", settledAt: new Date() }),
  });
  // Intercept createAdkAgent to capture the tools.
  setMockModule("@/lib/adk/agent-factory", {
    createAdkAgent: (cfg) => { capturedConfig = cfg; return {}; },
  });

  const { createPaymentsAgent: createAgent } = require("../../src/app/api/agents/payments/jsonrpc/_lib/adk-payments-agent.ts");
  createAgent({ businessId: "biz-001", actorUserId: "user-001" });

  assert.ok(capturedConfig !== null, "createAdkAgent must have been called");
  const toolNames = capturedConfig.tools.map((t) => t.name ?? t.cfg?.name ?? "(unknown)");
  assert.ok(
    toolNames.includes("settle_promesa_payment"),
    `settle_promesa_payment must be in the tools array. Found: ${toolNames.join(", ")}`,
  );
});

// ── 2. settle_promesa_payment tool: amount=0 rejected at tool level ──────────

test("settle_promesa_payment tool: amount=0 returns invalid_amount error", async () => {
  const { buildSettlePromesaPaymentTool } = loadSettleTool({
    settleResult: { outcome: "settled", cashMovementId: "cm-001", settledAt: new Date() },
  });
  const tool = buildSettlePromesaPaymentTool({ businessId: "biz-001", actorUserId: "user-001" });
  const result = await tool._execute({
    originalPaymentIntentId: "pi-promesa-001",
    paymentMethod: "efectivo",
    amount: 0,
  });
  assert.equal(result.error, "invalid_amount", "amount=0 must return invalid_amount");
});

test("settle_promesa_payment tool: missing businessId returns missing_context error", async () => {
  const { buildSettlePromesaPaymentTool } = loadSettleTool({
    settleResult: { outcome: "settled", cashMovementId: "cm-001", settledAt: new Date() },
  });
  const tool = buildSettlePromesaPaymentTool({ businessId: null, actorUserId: null });
  const result = await tool._execute({
    originalPaymentIntentId: "pi-promesa-001",
    paymentMethod: "efectivo",
    amount: 500,
  });
  assert.equal(result.error, "missing_context", "null businessId must return missing_context");
});

test("settle_promesa_payment tool: delegates to use-case and returns success", async () => {
  const settledAt = new Date("2026-06-01T12:00:00Z");
  const { buildSettlePromesaPaymentTool } = loadSettleTool({
    settleResult: { outcome: "settled", cashMovementId: "cm-success-001", settledAt },
  });
  const tool = buildSettlePromesaPaymentTool({ businessId: "biz-001", actorUserId: "user-001" });
  const result = await tool._execute({
    originalPaymentIntentId: "pi-promesa-001",
    paymentMethod: "transferencia",
    amount: 1500,
    reason: "Juan transfirió",
  });
  assert.equal(result.success, true);
  assert.equal(result.cashMovementId, "cm-success-001");
  assert.equal(result.currency, "ARS");
});

// ── 3. Customer-path A2A message does NOT contain precio_unitario ─────────────
//
// Regression guard: the message text sent from the Customer Agent to the Payments
// Agent must NOT include "precio_unitario=" keys. If it did, the Payments LLM
// could forward that value as unitPriceOverride to create_payment_link, allowing
// a stale cart price to override the DB price (same class as CRITICAL #1).
//
// The fix (approach a): remove precio_unitario from the item line format in
// customer-agent-tools-checkout.ts. This test verifies the invariant by
// checking the A2A message sent to the Payments Agent.

test("customer checkout: A2A message to Payments does not contain precio_unitario", async () => {
  // Build a fake session state that has an order with one item.
  const fakeState = new Map([
    ["order", {
      items: [{ productId: "prod-001", name: "Alfajor Triple", qty: 3, unitPrice: 500, lineTotal: 1500 }],
      subtotal: 1500,
    }],
    ["user:customer_id", "cust-001"],
    ["user:customer_name", "Test Customer"],
  ]);

  let capturedMessage = null;

  resetSourceModules();
  clearMockModules();
  setMockModule("@/lib/cloud-logger", makeCloudLoggerMock());
  setMockModule("@/lib/agent-identity", { signAgentAssertion: () => null });
  setMockModule("@/app/api/a2a/jsonrpc/_lib/handle-rpc", { deriveA2AKey: () => "key" });
  setMockModule("@/lib/agent-timeouts", { PAYMENTS_AGENT_TIMEOUT_MS: 65000 });
  setMockModule("@/lib/shipping-quote", {
    resolveShippingQuote: async () => ({ ok: false, reason: "missing_destination_postal_code" }),
  });
  setMockModule("@/lib/a2a-client", {
    sendMessage: async (url, msg) => {
      capturedMessage = msg;
      return { text: "Link generado: https://mp.com/pay" };
    },
    A2AClientError: class A2AClientError extends Error {},
  });
  setMockModule("@google/adk", {
    FunctionTool: class FakeFunctionTool {
      constructor(cfg) { this.cfg = cfg; this.name = cfg.name; this._execute = cfg.execute; }
      async execute(...args) { return this._execute(...args); }
    },
  });

  // Provide a module hook for customer-agent-tools-order readOrder function
  // by loading it from its actual source path.
  const { createPaymentLinkForCustomerTool } = require("../../src/lib/adk/customer-agent-tools-checkout.ts");

  const tool = createPaymentLinkForCustomerTool({
    businessId: "biz-001",
    appUrl: "https://velora.example.com",
  });

  const fakeToolContext = {
    state: {
      get: (key) => fakeState.get(key),
      set: (key, val) => fakeState.set(key, val),
    },
  };

  await tool._execute({ confirmed: true }, fakeToolContext);

  assert.ok(capturedMessage !== null, "A2A message must have been sent");
  assert.ok(
    !capturedMessage.includes("precio_unitario"),
    `A2A message must NOT contain "precio_unitario". Got: ${capturedMessage}`,
  );
});

test("customer checkout: A2A message contains productId and cantidad (routing info still present)", async () => {
  const fakeState = new Map([
    ["order", {
      items: [{ productId: "prod-001", name: "Alfajor Triple", qty: 3, unitPrice: 500, lineTotal: 1500 }],
      subtotal: 1500,
    }],
    ["user:customer_id", "cust-001"],
    ["user:customer_name", "Test Customer"],
  ]);

  let capturedMessage = null;

  resetSourceModules();
  clearMockModules();
  setMockModule("@/lib/cloud-logger", makeCloudLoggerMock());
  setMockModule("@/lib/agent-identity", { signAgentAssertion: () => null });
  setMockModule("@/app/api/a2a/jsonrpc/_lib/handle-rpc", { deriveA2AKey: () => "key" });
  setMockModule("@/lib/agent-timeouts", { PAYMENTS_AGENT_TIMEOUT_MS: 65000 });
  setMockModule("@/lib/shipping-quote", {
    resolveShippingQuote: async () => ({ ok: false, reason: "missing_destination_postal_code" }),
  });
  setMockModule("@/lib/a2a-client", {
    sendMessage: async (url, msg) => {
      capturedMessage = msg;
      return { text: "Link generado: https://mp.com/pay" };
    },
    A2AClientError: class A2AClientError extends Error {},
  });
  setMockModule("@google/adk", {
    FunctionTool: class FakeFunctionTool {
      constructor(cfg) { this.cfg = cfg; this.name = cfg.name; this._execute = cfg.execute; }
      async execute(...args) { return this._execute(...args); }
    },
  });

  const { createPaymentLinkForCustomerTool } = require("../../src/lib/adk/customer-agent-tools-checkout.ts");
  const tool = createPaymentLinkForCustomerTool({
    businessId: "biz-001",
    appUrl: "https://velora.example.com",
  });

  const fakeToolContext = {
    state: {
      get: (key) => fakeState.get(key),
      set: (key, val) => fakeState.set(key, val),
    },
  };

  await tool._execute({ confirmed: true }, fakeToolContext);

  assert.ok(capturedMessage !== null, "A2A message must have been sent");
  assert.ok(capturedMessage.includes("prod-001"), "message must contain productId for routing");
  assert.ok(capturedMessage.includes("cantidad=3"), "message must contain quantity for routing");
  assert.ok(capturedMessage.includes("Alfajor Triple"), "message must contain product name for display");
});

// ── 4. settlePromesaUseCase: zero/negative monto guard (FIX 2 regression) ────
//
// A promesa with monto=0 (or monto<0) cannot validate a positive settle amount
// against a plausibility multiple. Any positive amount must be rejected with
// amount_too_large rather than silently accepted.
// Positive-monto behavior must remain unchanged: <2× accepted, >2× rejected.

function makePrismaForSettle({ monto, metodo = "promesa", estado = "confirmed", existingCashMovement = null }) {
  return {
    prisma: {
      paymentIntent: {
        findFirst: async () => ({
          id: "pi-test-settle-001",
          metodo,
          estado,
          saleId: "sale-001",
          monto, // plain number — Number(monto) works for both 0 and positive values
        }),
      },
      cashMovement: {
        findFirst: async () => existingCashMovement,
        create: async ({ data }) => ({ id: "cm-new-001", ...data }),
      },
    },
  };
}

const BASE_SETTLE_INPUT = {
  originalPaymentIntentId: "pi-test-settle-001",
  businessId: "biz-test-001",
  actorUserId: "user-test-001",
  paymentMethod: "efectivo",
  amount: 1500,
};

function loadSettleUseCaseWithMonto(monto) {
  resetSourceModules();
  clearMockModules();
  setMockModule("@/lib/cloud-logger", makeCloudLoggerMock());
  setMockModule("@/infrastructure/shared/critical-write-audit", {
    recordCriticalWriteEvent: async () => {},
  });
  setMockModule("@/app/api/_lib/mutation-contract", {
    getServerActionMeta: () => ({
      routeScope: "payments",
      actionType: "payment_intent.settle_promesa",
      resourceType: "payment_intent",
    }),
  });
  setMockModule("@/lib/prisma", makePrismaForSettle({ monto }));
  return require("../../src/app/api/payment-intents/_lib/settle-promesa-use-case.ts");
}

test("settlePromesaUseCase: monto=0 + positive amount → invalid_promesa_monto (not amount_too_large)", async () => {
  const { settlePromesaUseCase } = loadSettleUseCaseWithMonto(0);
  const result = await settlePromesaUseCase({ ...BASE_SETTLE_INPUT, amount: 1500 });
  assert.strictEqual(
    result.outcome,
    "invalid_promesa_monto",
    "monto=0 with any positive amount must return invalid_promesa_monto",
  );
});

test("settlePromesaUseCase: monto=-100 + positive amount → invalid_promesa_monto (not amount_too_large)", async () => {
  const { settlePromesaUseCase } = loadSettleUseCaseWithMonto(-100);
  const result = await settlePromesaUseCase({ ...BASE_SETTLE_INPUT, amount: 50 });
  assert.strictEqual(
    result.outcome,
    "invalid_promesa_monto",
    "monto=-100 with any positive amount must return invalid_promesa_monto",
  );
});

test("settlePromesaUseCase: positive monto, amount within 2× → settled", async () => {
  const { settlePromesaUseCase } = loadSettleUseCaseWithMonto(1000);
  const result = await settlePromesaUseCase({ ...BASE_SETTLE_INPUT, amount: 1000 });
  assert.strictEqual(
    result.outcome,
    "settled",
    "amount within 2× of positive monto must succeed",
  );
});

test("settlePromesaUseCase: positive monto, amount > 2× → amount_too_large", async () => {
  const { settlePromesaUseCase } = loadSettleUseCaseWithMonto(1000);
  const result = await settlePromesaUseCase({ ...BASE_SETTLE_INPUT, amount: 2100 });
  assert.strictEqual(
    result.outcome,
    "amount_too_large",
    "amount > 2× positive monto must return amount_too_large",
  );
});

// ── 5. C-1 fix: omitted amount falls back to DB PI.monto ─────────────────────
//
// The canonical settle case ("ya me pagó la promesa") does NOT supply amount —
// the use-case must use PI.monto from the DB, never an LLM-echoed value.
// These tests verify that omitting amount still succeeds and uses the DB monto.

function loadSettleUseCaseWithMontoAndCapture(monto) {
  let capturedAmount = null;
  resetSourceModules();
  clearMockModules();
  setMockModule("@/lib/cloud-logger", makeCloudLoggerMock());
  setMockModule("@/infrastructure/shared/critical-write-audit", {
    recordCriticalWriteEvent: async () => {},
  });
  setMockModule("@/app/api/_lib/mutation-contract", {
    getServerActionMeta: () => ({
      routeScope: "payments",
      actionType: "payment_intent.settle_promesa",
      resourceType: "payment_intent",
    }),
  });
  const mockPrisma = {
    prisma: {
      paymentIntent: {
        findFirst: async () => ({
          id: "pi-test-settle-001",
          metodo: "promesa",
          estado: "confirmed",
          saleId: "sale-001",
          monto,
        }),
      },
      cashMovement: {
        findFirst: async () => null,
        create: async ({ data }) => { capturedAmount = data.amount; return { id: "cm-new-001", ...data }; },
      },
    },
  };
  setMockModule("@/lib/prisma", mockPrisma);
  const mod = require("../../src/app/api/payment-intents/_lib/settle-promesa-use-case.ts");
  return { mod, getCapture: () => capturedAmount };
}

test("settlePromesaUseCase: omitted amount → uses DB PI.monto (C-1 fix)", async () => {
  const { mod, getCapture } = loadSettleUseCaseWithMontoAndCapture(2500);
  // Omit amount entirely — standard "ya me pagó la promesa" case.
  const result = await mod.settlePromesaUseCase({
    originalPaymentIntentId: "pi-test-settle-001",
    businessId: "biz-test-001",
    actorUserId: "user-test-001",
    paymentMethod: "transferencia",
    // amount intentionally absent
  });
  assert.strictEqual(result.outcome, "settled", "omitted amount must settle successfully");
  assert.strictEqual(
    getCapture(),
    2500,
    "CashMovement amount must equal DB PI.monto (2500) when amount is omitted",
  );
});

test("settlePromesaUseCase: explicit amount overrides DB monto (partial payment)", async () => {
  const { mod, getCapture } = loadSettleUseCaseWithMontoAndCapture(2500);
  // Owner explicitly says "me pagó $1000 ahora, el resto después".
  const result = await mod.settlePromesaUseCase({
    originalPaymentIntentId: "pi-test-settle-001",
    businessId: "biz-test-001",
    actorUserId: "user-test-001",
    paymentMethod: "efectivo",
    amount: 1000,
  });
  assert.strictEqual(result.outcome, "settled", "explicit partial amount must settle successfully");
  assert.strictEqual(
    getCapture(),
    1000,
    "CashMovement amount must equal the explicit override (1000), not DB monto",
  );
});

test("settle tool: omitted amount passes through without invalid_amount error", async () => {
  const { buildSettlePromesaPaymentTool } = loadSettleTool({
    settleResult: { outcome: "settled", cashMovementId: "cm-001", settledAt: new Date() },
  });
  const tool = buildSettlePromesaPaymentTool({ businessId: "biz-001", actorUserId: "user-001" });
  const result = await tool._execute({
    originalPaymentIntentId: "pi-promesa-001",
    paymentMethod: "efectivo",
    // amount omitted — LLM did not supply it (standard case)
  });
  // Use-case is stubbed to return settled; we just verify the tool does not
  // short-circuit on missing amount before reaching the use-case.
  assert.equal(result.success, true, "omitted amount must not trigger invalid_amount short-circuit");
});
