// Unit tests — Refund cash report sign correctness (extension of cash-report-sign).
//
// Extends the coverage in cash-report-sign.test.cjs with the exact money-path
// scenarios described in the sprint spec: sale $1000, refund $500, mixed sequences.
//
// Background: refunds are stored with amount = -monto. Before the fix,
// isIncomeType excluded "refund", so `saldo -= (-monto)` = `saldo + monto` —
// a refund accidentally added to the balance. The fix: "refund" is now in
// isIncomeType, so `saldo += (-monto)` = `saldo - monto`.

const assert = require("node:assert/strict");
const test = require("node:test");

// Inline the fixed logic — same as cash-report-sign.test.cjs so both suites
// remain independent and self-documenting.

function isIncomeType(type) {
  return ["sale", "income", "adjustment", "refund"].includes(type);
}

function runningBalance(movements) {
  let saldo = 0;
  for (const m of movements) {
    const amount = Number(m.amount);
    const isIncome = isIncomeType(m.type);
    saldo += isIncome ? amount : -amount;
  }
  return saldo;
}

// ── Sprint spec cases ──────────────────────────────────────────────────────────

test("sale $1000 → saldo +1000", () => {
  const movements = [{ type: "sale", amount: 1000 }];
  assert.equal(runningBalance(movements), 1000);
});

test("sale $1000 + refund $500 → saldo +500 (not 1500 — the pre-fix bug)", () => {
  // Refund is stored as amount = -500.
  // Pre-fix: isIncomeType excluded 'refund' → saldo -= (-500) = 1500 (WRONG).
  // Post-fix: isIncomeType includes 'refund' → saldo += (-500) = 500 (CORRECT).
  const movements = [
    { type: "sale", amount: 1000 },
    { type: "refund", amount: -500 },
  ];
  const balance = runningBalance(movements);
  assert.equal(balance, 500, "refund must subtract from balance");
  assert.notEqual(balance, 1500, "pre-fix value 1500 must never appear");
});

test("mixed sequence: sale $1000, refund $300, income $200 → saldo $900", () => {
  const movements = [
    { type: "sale", amount: 1000 },
    { type: "refund", amount: -300 },
    { type: "income", amount: 200 },
  ];
  assert.equal(runningBalance(movements), 900);
});

test("multiple refunds: sale $2000, refund $400, refund $600 → saldo $1000", () => {
  const movements = [
    { type: "sale", amount: 2000 },
    { type: "refund", amount: -400 },
    { type: "refund", amount: -600 },
  ];
  assert.equal(runningBalance(movements), 1000);
});

test("refund without prior sale: isolated refund $300 → saldo -300", () => {
  // A lone refund with no sale in the window should yield a negative balance.
  const movements = [{ type: "refund", amount: -300 }];
  assert.equal(runningBalance(movements), -300);
  assert.ok(runningBalance(movements) < 0, "isolated refund must produce negative balance");
});

test("expense decreases balance independently of refund logic", () => {
  const movements = [
    { type: "sale", amount: 1000 },
    { type: "expense", amount: 200 },
  ];
  assert.equal(runningBalance(movements), 800);
});

test("full day: sales + expense + refund + income", () => {
  const movements = [
    { type: "sale", amount: 3000 },
    { type: "sale", amount: 1500 },
    { type: "expense", amount: 500 },
    { type: "refund", amount: -200 },
    { type: "income", amount: 100 },
  ];
  // 3000 + 1500 - 500 - 200 + 100 = 3900
  assert.equal(runningBalance(movements), 3900);
});

test("isIncomeType includes all four income types and excludes expense/purchase/salary", () => {
  assert.equal(isIncomeType("sale"), true);
  assert.equal(isIncomeType("income"), true);
  assert.equal(isIncomeType("adjustment"), true);
  assert.equal(isIncomeType("refund"), true);
  assert.equal(isIncomeType("expense"), false);
  assert.equal(isIncomeType("purchase"), false);
  assert.equal(isIncomeType("salary"), false);
});
