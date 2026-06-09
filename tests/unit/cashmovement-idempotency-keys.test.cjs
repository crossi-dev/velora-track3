"use strict";
// Unit tests — CashMovement idempotency-key deduplication for promesa-sale and refund.
//
// ERP-hardening SLICE 1: register-promesa-sale.transaction.ts and refund-transaction.ts
// now set clientMessageId on every CashMovement write. The partial unique index
// "CashMovement_businessId_clientMessageId_key" (migration 20260607100000)
// deduplicates concurrent retries via P2002 — treated as a successful no-op.
//
// This test suite validates:
//   1. The migration SQL exists and defines the partial unique index.
//   2. An in-memory mock correctly simulates P2002 on duplicate clientMessageId.
//   3. refund-transaction runRefundTransaction catches P2002 and returns "refunded".
//   4. register-promesa-sale.transaction sets clientMessageId = "promesa-sale-{key}".
//
// Sources:
//   https://docs.stripe.com/api/idempotent_requests
//   https://www.postgresql.org/docs/current/indexes-partial.html

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

// ── 1. Migration SQL validation ────────────────────────────────────────────────

test("migration SQL: 20260607100000 defines CashMovement_businessId_clientMessageId_key partial index", () => {
  const migPath = path.join(
    process.cwd(),
    "prisma/migrations/20260607100000_cashmovement_idempotency_keys/migration.sql"
  );
  const sql = fs.readFileSync(migPath, "utf8");
  assert.ok(
    sql.includes("CashMovement_businessId_clientMessageId_key"),
    "migration must define CashMovement_businessId_clientMessageId_key"
  );
  assert.ok(
    sql.includes("WHERE") && sql.includes("clientMessageId") && sql.includes("NOT NULL"),
    "index must be partial (WHERE clientMessageId IS NOT NULL)"
  );
  assert.ok(
    sql.includes("ADD COLUMN IF NOT EXISTS") && sql.includes('"clientMessageId"'),
    "migration must add clientMessageId column idempotently"
  );
});

// ── 2. In-memory mock: P2002 on duplicate businessId+clientMessageId ──────────

class MockCashMovementStore {
  constructor() {
    // key: "businessId:clientMessageId" — only when clientMessageId is non-null
    this._clientMessageIds = new Set();
    this._rows = [];
  }

  create(data) {
    const { businessId, clientMessageId } = data;
    if (clientMessageId !== null && clientMessageId !== undefined) {
      const key = `${businessId}:${clientMessageId}`;
      if (this._clientMessageIds.has(key)) {
        const err = new Error("Unique constraint violation");
        err.code = "P2002";
        err.meta = { target: ["CashMovement_businessId_clientMessageId_key"] };
        throw err;
      }
      this._clientMessageIds.add(key);
    }
    const row = { id: `cm-${this._rows.length + 1}`, ...data };
    this._rows.push(row);
    return row;
  }

  get rows() { return [...this._rows]; }
}

test("dedup: first create with clientMessageId=X → succeeds", () => {
  const store = new MockCashMovementStore();
  assert.doesNotThrow(() =>
    store.create({ businessId: "biz1", clientMessageId: "refund-pi123", type: "refund", amount: -500 })
  );
  assert.equal(store.rows.length, 1);
});

test("dedup: second create with same clientMessageId → P2002 (duplicate)", () => {
  const store = new MockCashMovementStore();
  store.create({ businessId: "biz1", clientMessageId: "refund-pi123", type: "refund", amount: -500 });
  assert.throws(
    () => store.create({ businessId: "biz1", clientMessageId: "refund-pi123", type: "refund", amount: -500 }),
    (err) => {
      assert.equal(err.code, "P2002");
      assert.ok(err.meta?.target?.includes("CashMovement_businessId_clientMessageId_key"));
      return true;
    }
  );
});

test("dedup: null clientMessageId rows never trigger P2002 (legacy rows tolerated)", () => {
  const store = new MockCashMovementStore();
  assert.doesNotThrow(() =>
    store.create({ businessId: "biz1", clientMessageId: null, type: "in", amount: 1000 })
  );
  assert.doesNotThrow(() =>
    store.create({ businessId: "biz1", clientMessageId: null, type: "in", amount: 2000 })
  );
  assert.equal(store.rows.length, 2);
});

test("dedup: same clientMessageId under different businessId → both succeed (no cross-tenant collision)", () => {
  const store = new MockCashMovementStore();
  assert.doesNotThrow(() =>
    store.create({ businessId: "biz1", clientMessageId: "refund-pi123", type: "refund", amount: -500 })
  );
  assert.doesNotThrow(() =>
    store.create({ businessId: "biz2", clientMessageId: "refund-pi123", type: "refund", amount: -500 })
  );
  assert.equal(store.rows.length, 2);
});

// ── 3. runRefundTransaction: P2002 → idempotent "refunded" outcome ─────────────

const {
  clearMockModules,
  resetSourceModules,
  setMockModule,
} = require("../phase4/module-hooks.cjs");

const PI_ID = "pi_test_001aaaaaaaaaaaaaa";
const BIZ_ID = "biz1aaaaaaaaaaaaaaaaaa";
const SALE_ID = "sale1aaaaaaaaaaaaaaaaa";

function buildFakePrisma({ piEstado = "confirmed", throwP2002 = false } = {}) {
  return {
    $transaction: async (fn) => fn(buildFakeTxClient({ piEstado, throwP2002 })),
    paymentIntent: {
      findFirst: async () => ({
        id: PI_ID,
        saleId: SALE_ID,
        monto: 1000,
        refundedAt: new Date(),
      }),
    },
  };
}

function buildFakeTxClient({ piEstado, throwP2002 }) {
  return {
    paymentIntent: {
      findFirst: async () => ({
        id: PI_ID,
        saleId: SALE_ID,
        monto: 1000,
        estado: piEstado,
      }),
      update: async () => ({}),
    },
    cashMovement: {
      create: async (opts) => {
        if (throwP2002) {
          const err = new Error("Unique constraint");
          err.code = "P2002";
          err.meta = { target: ["CashMovement_businessId_clientMessageId_key"] };
          throw err;
        }
        return { id: "cm-1", ...opts.data };
      },
    },
  };
}

function loadRunRefundTransaction(fakePrisma) {
  resetSourceModules();
  clearMockModules();
  setMockModule("@/lib/prisma", { prisma: fakePrisma });
  return require("../../src/app/api/payment-intents/_lib/refund-transaction.ts");
}

test("refund-transaction: normal path returns 'refunded' with clientMessageId set", async () => {
  const cashCreates = [];
  const fakePrisma = {
    $transaction: async (fn) => fn({
      paymentIntent: {
        findFirst: async () => ({ id: PI_ID, saleId: SALE_ID, monto: 1000, estado: "confirmed" }),
        update: async () => ({}),
      },
      cashMovement: {
        create: async (opts) => {
          cashCreates.push(opts.data);
          return { id: "cm-1", ...opts.data };
        },
      },
    }),
    paymentIntent: { findFirst: async () => null },
  };

  const { runRefundTransaction } = loadRunRefundTransaction(fakePrisma);
  const result = await runRefundTransaction({
    businessId: BIZ_ID,
    actorEmployeeId: null,
    paymentIntentId: PI_ID,
  });

  assert.equal(result.outcome, "refunded");
  assert.equal(cashCreates.length, 1, "exactly one CashMovement must be written");
  assert.equal(
    cashCreates[0].clientMessageId,
    `refund-${PI_ID}`,
    "clientMessageId must be refund-{piId}"
  );
  assert.equal(cashCreates[0].type, "refund", "type must be 'refund'");
  assert.ok(cashCreates[0].amount < 0, "refund amount must be negative");
});

test("refund-transaction: P2002 on clientMessageId → idempotent 'refunded' (no-op)", async () => {
  const now = new Date();
  const fakePrisma = {
    $transaction: async (fn) => {
      // Simulate P2002 thrown from inside the tx
      const err = new Error("Unique constraint");
      err.code = "P2002";
      err.meta = { target: ["CashMovement_businessId_clientMessageId_key"] };
      throw err;
    },
    paymentIntent: {
      findFirst: async () => ({
        id: PI_ID,
        saleId: SALE_ID,
        monto: 1000,
        refundedAt: now,
      }),
    },
  };

  const { runRefundTransaction } = loadRunRefundTransaction(fakePrisma);
  const result = await runRefundTransaction({
    businessId: BIZ_ID,
    actorEmployeeId: null,
    paymentIntentId: PI_ID,
  });

  assert.equal(result.outcome, "refunded", "P2002 must produce idempotent 'refunded' outcome");
  assert.equal(result.paymentIntentId, PI_ID);
  assert.equal(result.monto, 1000);
});

// ── 4. register-promesa-sale.transaction: clientMessageId = "promesa-sale-{key}" ──

function loadRunPromesaSaleTransaction() {
  resetSourceModules();
  clearMockModules();
  setMockModule("@/lib/cloud-logger", { cloudLog: () => {} });
  setMockModule("@/app/api/payment-intents/_lib/register-promesa-sale.invoice-builder", {
    buildRegisterPromesaSaleInvoice: async () => ({
      invoice: { id: "inv-1", invoiceNumber: "REC-0001-00000001" },
    }),
  });
  return require("../../src/app/api/payment-intents/_lib/register-promesa-sale.transaction.ts");
}

const IDEM_KEY = "test-idempotency-key-001";

test("register-promesa-sale.transaction: sets clientMessageId=promesa-sale-{idempotencyKey}", async () => {
  const cashCreates = [];
  const now = new Date();
  const expectedAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  const fakeTx = {
    business: {
      findUnique: async () => ({
        id: BIZ_ID,
        name: "Test Biz",
        currency: "ARS",
        cuit: "30-99999999-9",
        address: "Test 123",
        ivaCondition: "Monotributista",
        puntoVenta: "0001",
        iibb: null,
        activityStart: null,
        taxRate: 0,
        allowNegativeStock: false,
      }),
    },
    sale: {
      create: async () => ({ id: SALE_ID }),
    },
    saleItem: { createMany: async () => ({ count: 1 }) },
    product: { updateMany: async () => ({ count: 1 }) },
    cashMovement: {
      create: async (opts) => {
        cashCreates.push(opts.data);
        return { id: "cm-promesa-1", ...opts.data };
      },
    },
    paymentIntent: {
      create: async () => ({ id: PI_ID }),
    },
    // invoice + businessCounter required by buildRegisterPromesaSaleInvoice → sale-invoice.ts
    invoice: {
      findFirst: async () => null,
      create: async () => ({
        id: "inv-1",
        invoiceNumber: "REC-0001-00000001",
        sequenceNumber: 1,
        documentType: "receipt",
        issuedAt: now,
        payloadJson: "{}",
      }),
    },
    businessCounter: {
      upsert: async () => ({ id: "bc-1", businessId: BIZ_ID, counterType: "invoice:receipt", value: 1 }),
    },
  };

  const { runPromesaSaleTransaction } = loadRunPromesaSaleTransaction();
  await runPromesaSaleTransaction(fakeTx, {
    businessId: BIZ_ID,
    customer: {
      id: "cust1", name: "Test Customer", email: null, phone: null,
      taxId: null, dni: null, address: null, postalCode: null, city: null,
    },
    resolvedItems: [
      { productId: "prod1", productName: "Test Product", quantity: 1, unitPrice: 500, lineTotal: 500 },
    ],
    grandTotal: 500,
    now,
    expectedAt,
    expectedDateStr: expectedAt.toISOString().slice(0, 10),
    reason: undefined,
    idempotencyKey: IDEM_KEY,
    shipping: null,
    productMap: new Map([["prod1", { quantity: 10, name: "Test Product" }]]),
  });

  assert.equal(cashCreates.length, 1, "exactly one CashMovement must be written");
  assert.equal(
    cashCreates[0].clientMessageId,
    `promesa-sale-${IDEM_KEY}`,
    "clientMessageId must be promesa-sale-{idempotencyKey}"
  );
  assert.equal(cashCreates[0].type, "in");
  assert.equal(cashCreates[0].saleId, SALE_ID);
});
