// Unit tests — InvoiceSequence fallback uses `set` not `increment`.
//
// Background: when the BusinessCounter row exists with value=0 (upsert
// create path), the first upsert update fires `increment:1` and returns 1
// — which is > 0, so the early-return branch fires and we never hit the
// fallback. The fallback only triggers when the counter returns a value ≤ 0
// (e.g. after a manual reset or a corrupted row).
//
// The critical invariant: the fallback upsert must use `set: fallbackValue`
// not `increment: 1`. If it used increment, the counter would advance to
// fallbackValue+1 on the next call but only return fallbackValue this time,
// creating a gap. With `set`, subsequent callers increment from fallbackValue
// correctly.

"use strict";

process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgresql://test:test@localhost:5432/test";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  clearMockModules,
  resetSourceModules,
  setMockModule,
} = require("../phase4/module-hooks.cjs");

// ── Fake DB helpers ────────────────────────────────────────────────────────────

/**
 * Build an InvoiceSequenceClient-compatible object.
 *
 * counterStore: Map of counterType → current value (BigInt-like number)
 * invoiceStore: array of { sequenceNumber, documentType, businessId }
 *
 * The upsert mock tracks the most recent update call args so we can assert
 * that `set` (not `increment`) was used in the fallback path.
 */
function makeClient(counterStore, invoiceRows = []) {
  const upsertCalls = [];

  const client = {
    _upsertCalls: upsertCalls,
    businessCounter: {
      upsert: async ({ where, update, create, select }) => {
        upsertCalls.push({ where, update, create, select });
        const key = where.businessId_counterType.counterType;
        const bizId = where.businessId_counterType.businessId;
        const storeKey = `${bizId}:${key}`;

        if (counterStore.has(storeKey)) {
          // Row exists — apply update
          let current = counterStore.get(storeKey);
          if (update.value?.increment !== undefined) {
            current += update.value.increment;
          } else if (update.value?.set !== undefined) {
            current = update.value.set;
          }
          counterStore.set(storeKey, current);
          return { value: current };
        } else {
          // Row does not exist — apply create
          const initial = Number(create.value);
          counterStore.set(storeKey, initial);
          return { value: initial };
        }
      },
    },
    invoice: {
      findFirst: async ({ where, orderBy }) => {
        const matches = invoiceRows
          .filter(
            (r) =>
              r.businessId === where.businessId &&
              r.documentType === where.documentType
          )
          .sort((a, b) => b.sequenceNumber - a.sequenceNumber);
        return matches[0] ?? null;
      },
    },
  };

  return client;
}

// ── Load the module under test ─────────────────────────────────────────────────

function loadModule() {
  resetSourceModules();
  clearMockModules();
  // The module uses crypto.randomUUID — available in Node 14.17+, no mock needed.
  return require("../../src/infrastructure/shared/sale-invoice.ts");
}

// ── Tests ──────────────────────────────────────────────────────────────────────

test("invoice sequence: happy path — row exists with value=5 → returns 6", async () => {
  const { nextInvoiceSequenceNumber } = loadModule();
  const store = new Map([["biz1:invoice:invoice", 5]]);
  const client = makeClient(store);
  const seq = await nextInvoiceSequenceNumber(client, "biz1", "invoice");
  assert.equal(seq, 6);
});

test("invoice sequence: new row (no existing counter) → creates with value=1 and returns 1", async () => {
  const { nextInvoiceSequenceNumber } = loadModule();
  const store = new Map(); // no existing row
  const client = makeClient(store);
  const seq = await nextInvoiceSequenceNumber(client, "biz4", "invoice");
  assert.equal(seq, 1, "brand new counter must start at 1");
});

test("invoice sequence: counter increments monotonically across calls", async () => {
  const { nextInvoiceSequenceNumber } = loadModule();
  const store = new Map([["biz5:invoice:invoice", 3]]);
  const client = makeClient(store);
  const a = await nextInvoiceSequenceNumber(client, "biz5", "invoice");
  const b = await nextInvoiceSequenceNumber(client, "biz5", "invoice");
  assert.equal(a, 4);
  assert.equal(b, 5);
});

// ── Fallback path: counterValue <= 0 (e.g. counter manually zeroed) ───────────
//
// The fallback triggers when the upsert returns a value that is <= 0 or
// non-finite. The mock simulates this by returning a negative value from
// the upsert (which wouldn't happen in normal operation but can happen if
// a counter row is corrupted or manually reset to a negative/zero state
// without going through the increment path).
//
// The key invariant: the fallback must use `set: fallbackValue` so the
// next caller increments correctly from that baseline.

function makeClientWithForcedUpsertReturn(forcedValue, invoiceRows = []) {
  // Returns forcedValue on the FIRST upsert call, then behaves normally.
  let firstCall = true;
  const store = new Map();

  return {
    businessCounter: {
      upsert: async ({ where, update, create }) => {
        if (firstCall) {
          firstCall = false;
          // Simulate a corrupted/zeroed counter returning forcedValue.
          const key = `${where.businessId_counterType.businessId}:${where.businessId_counterType.counterType}`;
          store.set(key, forcedValue);
          return { value: forcedValue };
        }
        // Subsequent calls: normal increment behavior.
        const key = `${where.businessId_counterType.businessId}:${where.businessId_counterType.counterType}`;
        let current = store.get(key) ?? Number(create.value);
        if (update.value?.increment !== undefined) current += update.value.increment;
        else if (update.value?.set !== undefined) current = update.value.set;
        store.set(key, current);
        return { value: current };
      },
    },
    invoice: {
      findFirst: async ({ where }) => {
        const matches = invoiceRows
          .filter((r) => r.businessId === where.businessId && r.documentType === where.documentType)
          .sort((a, b) => b.sequenceNumber - a.sequenceNumber);
        return matches[0] ?? null;
      },
    },
    _store: store,
  };
}

test("invoice sequence fallback: upsert returns 0 → fallback returns 1 (no prior invoices)", async () => {
  const { nextInvoiceSequenceNumber } = loadModule();
  // First upsert returns 0 (counterValue <= 0 → fallback path).
  const client = makeClientWithForcedUpsertReturn(0, []);
  const seq = await nextInvoiceSequenceNumber(client, "biz6", "invoice");
  assert.equal(seq, 1, "fallback with no prior invoices must return 1");
});

test("invoice sequence fallback: upsert returns 0 with prior invoices (max=10) → returns 11", async () => {
  const { nextInvoiceSequenceNumber } = loadModule();
  const invoiceRows = [
    { businessId: "biz7", documentType: "invoice", sequenceNumber: 10 },
    { businessId: "biz7", documentType: "invoice", sequenceNumber: 8 },
  ];
  const client = makeClientWithForcedUpsertReturn(0, invoiceRows);
  const seq = await nextInvoiceSequenceNumber(client, "biz7", "invoice");
  assert.equal(seq, 11, "fallback must compute max+1 from existing invoices");
});

test("invoice sequence fallback: uses `set` not `increment` (source inspection)", () => {
  // Read the source to confirm the fallback upsert uses { set: fallbackValue }.
  // This is the invariant the comment documents — `increment` would cause drift.
  const fs = require("node:fs");
  const path = require("node:path");
  const src = fs.readFileSync(
    path.join(process.cwd(), "src/infrastructure/shared/sale-invoice.ts"),
    "utf8"
  );
  assert.ok(
    src.includes("set: fallbackValue"),
    "fallback upsert must use `set: fallbackValue` not `increment`"
  );
  // The fallback section (after fallbackValue is declared) must not use increment:1.
  const fallbackSection = src.slice(src.indexOf("const fallbackValue"));
  assert.ok(
    !fallbackSection.includes("increment: 1"),
    "fallback upsert must not use increment:1"
  );
});

test("invoice sequence fallback: after fallback with value=0, next call returns fallbackValue+1", async () => {
  const { nextInvoiceSequenceNumber } = loadModule();
  // First upsert returns 0 → fallback sets value to 1.
  // Second upsert (next call) should increment to 2.
  const client = makeClientWithForcedUpsertReturn(0, []);
  const first = await nextInvoiceSequenceNumber(client, "biz8", "invoice");
  assert.equal(first, 1, "first call (fallback) must return 1");

  const second = await nextInvoiceSequenceNumber(client, "biz8", "invoice");
  assert.equal(second, 2, "second call must return 2 (not drift to 3)");
});
