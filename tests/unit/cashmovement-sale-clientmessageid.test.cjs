// Unit test — CashMovement clientMessageId on sale-linked sync-payment movements.
//
// Fix B (Q7): createCashMovementInTransaction is called with
// clientMessageId = `sale-{saleId}` for sync-payment sales (efectivo, tarjeta).
// This adds an explicit audit token to the row so the payment is queryable by
// key without a saleId join, complementing the DB-level dedup enforced by the
// partial unique index CashMovement_saleId_cash_key (migration 20260519320000).
//
// This test validates:
//   1. For a sync-payment sale, the CashMovement is created with
//      clientMessageId = "sale-{saleId}".
//   2. For an async-payment sale (qr, transferencia), no CashMovement is
//      created at all (unchanged behaviour).

"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

// ── Minimal mock for createCashMovementInTransaction ──────────────────────────

// We test the sale-transaction module's caller side in isolation.
// Capture the options passed to createCashMovementInTransaction.

const CUID_SALE_ID = "sale1aaaaaaaaaaaaaaaaaa";
const BUSINESS_ID = "biz1aaaaaaaaaaaaaaaaaaa";

function buildSaleTransactionArgs({ paymentMethod = "efectivo" } = {}) {
  return {
    businessId: BUSINESS_ID,
    customerId: null,
    employeeId: null,
    fallbackCustomerName: "Consumidor Final",
    normalizedFallbackCustomerName: "consumidor final",
    checkedItems: [
      {
        productId: "prod1aaaaaaaaaaaaaaaaa",
        quantity: 1,
        unitPrice: 500,
        productName: "Test Product",
        unitCost: 250,
      },
    ],
    serverTotal: 500,
    allowNegativeStock: false,
    paymentMethod,
  };
}

// Build a fake Prisma transaction client that captures cashMovement.create calls.
function buildFakeTx({ saleId = CUID_SALE_ID } = {}) {
  const cashCreates = [];

  return {
    cashCreates,
    tx: {
      business: {
        findUnique: async () => ({
          id: BUSINESS_ID,
          name: "Velora Test",
          currency: "ARS",
          cuit: "30-99999999-9",
          address: "Test 123",
          whatsappPhone: null,
          notifyLowStockWa: false,
          ivaCondition: "Responsable Inscripto",
          puntoVenta: "0001",
          iibb: null,
          activityStart: null,
          taxRate: 0,
        }),
      },
      customer: {
        findFirst: async () => null,
        create: async () => ({ id: "custxaaaaaaaaaaaaaaaaaa", name: "Consumidor Final" }),
        upsert: async () => ({ id: "custxaaaaaaaaaaaaaaaaaa", name: "Consumidor Final" }),
      },
      sale: {
        create: async () => ({
          id: saleId,
          totalAmount: 500,
          taxAmount: 0,
          status: "paid",
          date: new Date(),
          paymentMethod: "efectivo",
        }),
      },
      saleItem: {
        createMany: async () => ({ count: 1 }),
      },
      product: {
        updateMany: async () => ({ count: 1 }),
        findFirst: async () => null,
      },
      stockMovement: {
        create: async () => ({ id: "sm1aaaaaaaaaaaaaaaaaaaa" }),
      },
      cashMovement: {
        create: async (opts) => {
          cashCreates.push(opts.data);
          return { id: "cm1aaaaaaaaaaaaaaaaaaaa", ...opts.data };
        },
      },
      invoice: {
        findFirst: async () => null,
        create: async () => ({
          id: "inv1aaaaaaaaaaaaaaaaaa",
          invoiceNumber: "REC-0001-00000001",
          sequenceNumber: 1,
          documentType: "receipt",
          issuedAt: new Date(),
          payloadJson: "{}",
        }),
      },
      invoiceSequence: {
        upsert: async () => ({ nextSeq: 1 }),
      },
    },
  };
}

const {
  clearMockModules,
  resetSourceModules,
  setMockModule,
} = require("../phase4/module-hooks.cjs");

function loadRunSaleTransaction(fakeTx) {
  resetSourceModules();
  clearMockModules();
  setMockModule("@/lib/cloud-logger", { cloudLog: () => {}, runWithTraceContext: (_, fn) => fn() });
  setMockModule("@/domain/errors", {
    BusinessNotFoundError: class BusinessNotFoundError extends Error {},
    InsufficientStockError: class InsufficientStockError extends Error {},
    CustomerNotFoundError: class CustomerNotFoundError extends Error {},
  });
  setMockModule("@/infrastructure/shared/sale-customer", {
    resolveSaleCustomerInTransaction: async () => ({ id: "custxaaaaaaaaaaaaaaaaaa", name: "Consumidor Final" }),
    normalizeCustomerName: (n) => n ?? "Consumidor Final",
    CONSUMIDOR_FINAL_NAME: "Consumidor Final",
  });
  setMockModule("@/infrastructure/shared/sale-inventory", {
    processCheckedItemsInTransaction: async () => ({
      saleItemsForInvoice: [{ productName: "Test Product", quantity: 1, unitPrice: 500, subtotal: 500 }],
      lowStockAlerts: [],
    }),
  });
  setMockModule("@/infrastructure/shared/sale-invoice", {
    nextInvoiceSequenceNumber: async () => 1,
    buildSaleInvoicePayload: () => ({
      sale: { id: "sale-id", items: [], total: 500, invoiceNumber: "REC-0001-00000001", currency: "ARS", date: new Date().toISOString() },
      business: {},
      customer: {},
    }),
  });
  return require("../../src/infrastructure/shared/sale-transaction.ts");
}

// ── Tests ──────────────────────────────────────────────────────────────────────

test("clientMessageId: sync-payment sale sets clientMessageId=sale-{saleId} on CashMovement", async () => {
  const { cashCreates, tx } = buildFakeTx({ saleId: CUID_SALE_ID });
  const { runSaleTransaction } = loadRunSaleTransaction(tx);

  await runSaleTransaction(tx, buildSaleTransactionArgs({ paymentMethod: "efectivo" }));

  assert.equal(cashCreates.length, 1, "exactly one CashMovement must be created for sync payment");
  assert.equal(
    cashCreates[0].clientMessageId,
    `sale-${CUID_SALE_ID}`,
    "clientMessageId must be sale-{saleId}"
  );
  assert.equal(cashCreates[0].saleId, CUID_SALE_ID, "saleId must be set");
  assert.equal(cashCreates[0].type, "sale", "type must be 'sale'");
});

test("clientMessageId: async-payment sale (qr) creates NO CashMovement", async () => {
  const { cashCreates, tx } = buildFakeTx({ saleId: CUID_SALE_ID });
  // Override sale status for async
  tx.sale.create = async () => ({
    id: CUID_SALE_ID,
    totalAmount: 500,
    taxAmount: 0,
    status: "pending",
    date: new Date(),
    paymentMethod: "qr",
  });
  const { runSaleTransaction } = loadRunSaleTransaction(tx);

  await runSaleTransaction(tx, buildSaleTransactionArgs({ paymentMethod: "qr" }));

  assert.equal(cashCreates.length, 0, "async payment must NOT create CashMovement (deferred to confirm-transaction)");
});
