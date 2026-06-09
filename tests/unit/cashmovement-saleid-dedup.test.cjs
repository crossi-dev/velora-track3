// Unit tests — CashMovement saleId deduplication (BLOCKER fix).
//
// Migration 20260519320000_cashmovement_saleid_dedup adds a partial unique index:
//   CREATE UNIQUE INDEX "CashMovement_saleId_cash_key"
//       ON "CashMovement"("saleId")
//       WHERE "saleId" IS NOT NULL AND "type" IN ('income', 'sale');
//
// This means:
//   - First create with saleId=X, type='income' → succeeds
//   - Second create with saleId=X, type='income' → P2002 (duplicate)
//   - Create with saleId=X, type='sale' → P2002 (also covered by index)
//   - Create with saleId=X, type='refund' → succeeds (excluded from index)
//   - Create with saleId=null → always succeeds (null excluded from index)
//
// The DB enforces this at the SQL level. This test suite validates:
//   1. The constraint exists in the migration SQL.
//   2. An in-memory mock correctly simulates the partial-unique semantics.
//   3. Callers that catch P2002 can distinguish duplicate from DB errors.

"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

// ── Confirm migration SQL contains the correct constraint ──────────────────────

test("migration SQL: partial unique index covers saleId + type IN (income, sale)", () => {
  const migPath = path.join(
    process.cwd(),
    "prisma/migrations/20260519320000_cashmovement_saleid_dedup/migration.sql"
  );
  const sql = fs.readFileSync(migPath, "utf8");
  assert.ok(
    sql.includes("CashMovement_saleId_cash_key"),
    "migration must define CashMovement_saleId_cash_key index"
  );
  assert.ok(
    sql.includes("WHERE") && sql.includes("saleId") && sql.includes("NOT NULL"),
    "index must be partial (WHERE saleId IS NOT NULL)"
  );
  assert.ok(
    sql.includes("'income'") && sql.includes("'sale'"),
    "index must cover type IN ('income', 'sale')"
  );
  // Refund must NOT be listed in the covered types.
  // We check it's not in the WHERE clause of the index definition.
  const whereClause = sql.slice(sql.indexOf("WHERE"));
  assert.ok(
    !whereClause.includes("'refund'"),
    "refund must be excluded from the partial index"
  );
});

// ── In-memory mock simulating partial-unique semantics ─────────────────────────

const CASH_TYPES_IN_INDEX = new Set(["income", "sale"]);

class MockCashMovementStore {
  constructor() {
    // Set of "saleId:type" — only for types covered by the partial index.
    this._seen = new Set();
    this._rows = [];
  }

  create(data) {
    const { saleId, type } = data;
    // Partial index: only applies when saleId is not null AND type IN ('income','sale').
    if (saleId !== null && saleId !== undefined && CASH_TYPES_IN_INDEX.has(type)) {
      const key = `${saleId}:INDEXED`; // all index-covered types share the per-saleId slot
      if (this._seen.has(key)) {
        const err = new Error("Unique constraint violation");
        err.code = "P2002";
        err.meta = { target: ["CashMovement_saleId_cash_key"] };
        throw err;
      }
      this._seen.add(key);
    }
    const row = { id: `cm-${this._rows.length + 1}`, ...data };
    this._rows.push(row);
    return row;
  }

  get rows() {
    return [...this._rows];
  }
}

// ── Tests ──────────────────────────────────────────────────────────────────────

test("dedup: first create with saleId=X, type='income' → succeeds", () => {
  const store = new MockCashMovementStore();
  assert.doesNotThrow(() =>
    store.create({ saleId: "sale-1", type: "income", amount: 1000, businessId: "biz1", description: "test" })
  );
  assert.equal(store.rows.length, 1);
});

test("dedup: second create with saleId=X, type='income' → P2002 (duplicate)", () => {
  const store = new MockCashMovementStore();
  store.create({ saleId: "sale-2", type: "income", amount: 1000, businessId: "biz1", description: "first" });
  assert.throws(
    () => store.create({ saleId: "sale-2", type: "income", amount: 1000, businessId: "biz1", description: "second" }),
    (err) => {
      assert.equal(err.code, "P2002", "must throw P2002");
      return true;
    }
  );
});

test("dedup: second create with saleId=X, type='sale' → P2002 (same partial index)", () => {
  // The index covers BOTH 'income' and 'sale' for the same saleId — only one
  // row of either type is allowed.
  const store = new MockCashMovementStore();
  store.create({ saleId: "sale-3", type: "income", amount: 1000, businessId: "biz1", description: "income" });
  assert.throws(
    () => store.create({ saleId: "sale-3", type: "sale", amount: 1000, businessId: "biz1", description: "sale" }),
    (err) => {
      assert.equal(err.code, "P2002");
      return true;
    }
  );
});

test("dedup: create with saleId=X, type='refund' → SUCCEEDS (refund excluded from index)", () => {
  const store = new MockCashMovementStore();
  // Even after an income row exists for the same saleId, a refund must be allowed.
  store.create({ saleId: "sale-4", type: "income", amount: 1000, businessId: "biz1", description: "income" });
  assert.doesNotThrow(() =>
    store.create({ saleId: "sale-4", type: "refund", amount: -500, businessId: "biz1", description: "refund" })
  );
  assert.equal(store.rows.length, 2);
});

test("dedup: create with saleId=null → always succeeds (null excluded from index)", () => {
  const store = new MockCashMovementStore();
  // Multiple rows with saleId=null and same type must be allowed.
  assert.doesNotThrow(() =>
    store.create({ saleId: null, type: "income", amount: 500, businessId: "biz1", description: "cash-in-1" })
  );
  assert.doesNotThrow(() =>
    store.create({ saleId: null, type: "income", amount: 300, businessId: "biz1", description: "cash-in-2" })
  );
  assert.equal(store.rows.length, 2);
});

test("dedup: different saleIds → both income rows succeed", () => {
  const store = new MockCashMovementStore();
  assert.doesNotThrow(() =>
    store.create({ saleId: "sale-A", type: "income", amount: 1000, businessId: "biz1", description: "A" })
  );
  assert.doesNotThrow(() =>
    store.create({ saleId: "sale-B", type: "income", amount: 2000, businessId: "biz1", description: "B" })
  );
  assert.equal(store.rows.length, 2);
});

test("dedup: caller can detect P2002 and distinguish it from generic DB errors", () => {
  const store = new MockCashMovementStore();
  store.create({ saleId: "sale-5", type: "income", amount: 1000, businessId: "biz1", description: "first" });

  let caughtCode = null;
  try {
    store.create({ saleId: "sale-5", type: "income", amount: 1000, businessId: "biz1", description: "second" });
  } catch (err) {
    caughtCode = err.code;
  }

  assert.equal(caughtCode, "P2002", "caller must be able to detect P2002 for idempotency handling");
});
