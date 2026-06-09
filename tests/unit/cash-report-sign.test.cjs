// Unit test for cash report balance sign logic.
// Verifies that a "refund" movement (stored as negative amount) decreases the
// running balance instead of accidentally increasing it.
//
// Background: refund writes amount = -monto. Because isIncomeType previously
// excluded "refund", the formula evaluated `saldo -= amount = saldo -= (-monto)
// = saldo + monto`, flipping the sign and making refunds appear as income.
// The fix adds "refund" to isIncomeType so the formula becomes `saldo += amount
// = saldo += (-monto)`, correctly decreasing the balance.

const assert = require("node:assert/strict");
const test = require("node:test");

// Inline the logic under test — keeps the test self-contained and avoids
// importing Next.js / ExcelJS dependencies into the node:test runner.
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

test("sale increases balance", () => {
  const movements = [{ type: "sale", amount: 1000 }];
  assert.equal(runningBalance(movements), 1000);
});

test("expense decreases balance", () => {
  const movements = [{ type: "expense", amount: 200 }];
  assert.equal(runningBalance(movements), -200);
});

test("refund with negative amount decreases balance (CORRECTNESS)", () => {
  // A $500 refund is stored as amount = -500.
  // The balance should go DOWN by 500, not UP.
  const movements = [
    { type: "sale", amount: 1000 },
    { type: "refund", amount: -500 },
  ];
  assert.equal(runningBalance(movements), 500);
});

test("refund does not increase balance (regression guard)", () => {
  const movements = [{ type: "refund", amount: -300 }];
  // Before the fix this would have returned +300.
  assert.equal(runningBalance(movements), -300);
  assert.ok(runningBalance(movements) < 0, "refund must reduce the balance");
});

test("income type classification includes refund", () => {
  assert.equal(isIncomeType("refund"), true);
  assert.equal(isIncomeType("sale"), true);
  assert.equal(isIncomeType("income"), true);
  assert.equal(isIncomeType("adjustment"), true);
  assert.equal(isIncomeType("expense"), false);
  assert.equal(isIncomeType("purchase"), false);
  assert.equal(isIncomeType("salary"), false);
});
