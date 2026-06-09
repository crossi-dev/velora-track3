// payments-settle-amount-dbfirst.test.cjs
//
// Standalone C-1 DB-first regression suite for the settle_promesa amount fix.
// Isolated from payments-settle-tool-registration.test.cjs so that the
// pre-existing MODULE_NOT_FOUND for @velora/core-utils/missing-business-data
// (triggered only when loading the full payments-agent-tools graph) does NOT
// prevent these critical money-path tests from running.
//
// Covers (C-1 fix — fix(payments): settle_promesa amount DB-first):
//   C1. Omitted amount → CashMovement.amount === DB PI.monto (not 0 / NaN)
//   C2. Explicit amount override → CashMovement.amount === supplied value
//   C3. Tool-level passthrough — omitted amount does not trigger invalid_amount

"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  clearMockModules,
  resetSourceModules,
  setMockModule,
} = require("../phase4/module-hooks.cjs");

// ---------------------------------------------------------------------------
// Minimal stubs (only what settle-promesa-use-case.ts and
// payments-settle-tool.ts actually import — no payments-agent-tools graph)
// ---------------------------------------------------------------------------

function makeCloudLoggerMock() {
  return { cloudLog: () => {} };
}

function makeCriticalWriteAuditMock() {
  return { recordCriticalWriteEvent: async () => {} };
}

function makeMutationContractMock() {
  return {
    getServerActionMeta: () => ({
      routeScope: "payments",
      actionType: "payment_intent.settle_promesa",
      resourceType: "payment_intent",
    }),
  };
}

/**
 * Load the settle use-case with a prisma mock wired to a specific PI.monto.
 * Returns { mod, getCapture } where getCapture() returns the amount that was
 * passed to prisma.cashMovement.create().
 */
function loadSettleUseCaseCapturing(monto) {
  let capturedAmount = null;

  resetSourceModules();
  clearMockModules();

  setMockModule("@/lib/cloud-logger", makeCloudLoggerMock());
  setMockModule("@/infrastructure/shared/critical-write-audit", makeCriticalWriteAuditMock());
  setMockModule("@/app/api/_lib/mutation-contract", makeMutationContractMock());
  setMockModule("@/lib/prisma", {
    prisma: {
      paymentIntent: {
        findFirst: async () => ({
          id: "pi-dbfirst-001",
          metodo: "promesa",
          estado: "confirmed",
          saleId: "sale-001",
          monto, // Decimal field — Number(monto) normalises it
        }),
      },
      cashMovement: {
        findFirst: async () => null, // not yet settled
        create: async ({ data }) => {
          capturedAmount = data.amount;
          return { id: "cm-capture-001", ...data };
        },
      },
    },
  });

  const mod = require("../../src/app/api/payment-intents/_lib/settle-promesa-use-case.ts");
  return { mod, getCapture: () => capturedAmount };
}

/**
 * Load payments-settle-tool.ts with a stubbed use-case.
 * The FunctionTool mock exposes _execute() so we can call it directly.
 */
function loadSettleToolStubbed({ settleResult }) {
  resetSourceModules();
  clearMockModules();

  setMockModule("@/lib/cloud-logger", makeCloudLoggerMock());
  setMockModule("@/app/api/payment-intents/_lib/settle-promesa-use-case", {
    settlePromesaUseCase: async () => settleResult,
  });
  setMockModule("@google/adk", {
    FunctionTool: class FakeFunctionTool {
      constructor(cfg) {
        this.cfg = cfg;
        this.name = cfg.name;
        this._execute = cfg.execute;
      }
      async execute(...args) {
        return this._execute(...args);
      }
    },
  });

  return require("../../src/app/api/agents/payments/jsonrpc/_lib/payments-settle-tool.ts");
}

// ---------------------------------------------------------------------------
// C1 — Omitted amount → CashMovement.amount === DB PI.monto
// ---------------------------------------------------------------------------

test("C1: settlePromesaUseCase — omitted amount uses DB PI.monto (2500)", async () => {
  const { mod, getCapture } = loadSettleUseCaseCapturing(2500);

  const result = await mod.settlePromesaUseCase({
    originalPaymentIntentId: "pi-dbfirst-001",
    businessId: "biz-001",
    actorUserId: "user-001",
    paymentMethod: "transferencia",
    // amount intentionally absent — canonical "ya me pagó la promesa" case
  });

  assert.strictEqual(result.outcome, "settled", "omitted amount must settle successfully");
  assert.strictEqual(
    getCapture(),
    2500,
    `CashMovement.amount must equal DB PI.monto (2500) when amount is omitted. Got: ${getCapture()}`,
  );
});

// ---------------------------------------------------------------------------
// C2 — Explicit amount overrides DB monto (partial payment)
// ---------------------------------------------------------------------------

test("C2: settlePromesaUseCase — explicit amount overrides DB PI.monto", async () => {
  const { mod, getCapture } = loadSettleUseCaseCapturing(2500);

  // Owner explicitly says "me pagó $1000 a cuenta"
  const result = await mod.settlePromesaUseCase({
    originalPaymentIntentId: "pi-dbfirst-001",
    businessId: "biz-001",
    actorUserId: "user-001",
    paymentMethod: "efectivo",
    amount: 1000,
  });

  assert.strictEqual(result.outcome, "settled", "explicit partial amount must settle successfully");
  assert.strictEqual(
    getCapture(),
    1000,
    `CashMovement.amount must equal the explicit override (1000), not DB monto (2500). Got: ${getCapture()}`,
  );
});

// ---------------------------------------------------------------------------
// C3 — Tool-level passthrough: omitted amount does not short-circuit
// ---------------------------------------------------------------------------

test("C3: settle tool — omitted amount passes through to use-case (no invalid_amount)", async () => {
  const { buildSettlePromesaPaymentTool } = loadSettleToolStubbed({
    settleResult: { outcome: "settled", cashMovementId: "cm-001", settledAt: new Date() },
  });

  const tool = buildSettlePromesaPaymentTool({ businessId: "biz-001", actorUserId: "user-001" });
  const result = await tool._execute({
    originalPaymentIntentId: "pi-dbfirst-001",
    paymentMethod: "transferencia",
    // amount omitted — standard "ya me pagó" case
  });

  assert.equal(
    result.success,
    true,
    "omitted amount must not trigger invalid_amount guard at tool level",
  );
});
