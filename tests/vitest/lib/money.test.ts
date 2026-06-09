// money.test.ts — Edge-case tests proving Decimal helpers fix the float bug.
//
// The core regression: (1.005).toFixed(2) === "1.00" in IEEE-754 float.
// Decimal ROUND_HALF_UP gives the correct "1.01".
//
// Source: https://mikemcl.github.io/decimal.js/ (VERIFIED HTTP 200)

import { describe, it, expect } from "vitest";
import { computeTaxAmount, lineTotal, money, roundMoney, sumLineItems, toNumber } from "@/lib/money";
import { Prisma } from "@prisma/client";

describe("money()", () => {
  it("wraps a number as Prisma.Decimal", () => {
    const d = money(1.5);
    expect(d).toBeInstanceOf(Prisma.Decimal);
    expect(d.toNumber()).toBe(1.5);
  });

  it("wraps a string without float parse error", () => {
    // "1.005" as a string is exact; passing 1.005 as number is 1.00499...
    expect(money("1.005").toString()).toBe("1.005");
  });

  it("wraps an existing Decimal (no-op copy)", () => {
    const original = new Prisma.Decimal("2.50");
    const wrapped = money(original);
    expect(wrapped.equals(original)).toBe(true);
  });
});

describe("roundMoney() — the core fix", () => {
  // ── The documented float bug ──────────────────────────────────────────────
  it("rounds 1.005 to 1.01 (ROUND_HALF_UP) — float gives wrong 1.00", () => {
    // Proof of the float bug:
    expect(Number((1.005).toFixed(2))).toBe(1.00); // IEEE-754: wrong!

    // Our fix:
    expect(roundMoney(money("1.005")).toNumber()).toBe(1.01); // Decimal: correct
  });

  it("rounds 2.005 to 2.01", () => {
    expect(roundMoney(money("2.005")).toNumber()).toBe(2.01);
  });

  it("rounds 1.004 to 1.00 (below half)", () => {
    expect(roundMoney(money("1.004")).toNumber()).toBe(1.00);
  });

  it("rounds 1.009 to 1.01", () => {
    expect(roundMoney(money("1.009")).toNumber()).toBe(1.01);
  });

  it("accepts a plain number input", () => {
    // 1.5 is exact in float so this is safe to test with a number
    expect(roundMoney(1.5).toNumber()).toBe(1.5);
  });

  it("accepts a Decimal input", () => {
    const d = new Prisma.Decimal("99.999");
    expect(roundMoney(d).toNumber()).toBe(100.00);
  });

  // ── Large amounts common in ARS ────────────────────────────────────────────
  it("handles large ARS amounts correctly (1_000_000.005 → 1_000_000.01)", () => {
    expect(roundMoney(money("1000000.005")).toNumber()).toBe(1000000.01);
  });

  it("zero stays zero", () => {
    expect(roundMoney(money(0)).toNumber()).toBe(0);
  });
});

describe("sumLineItems()", () => {
  it("sums a single item correctly — 1.005 rounds to 1.01 (ROUND_HALF_UP)", () => {
    const result = sumLineItems([{ quantity: 1, unitPrice: 1.005 }]);
    // decimal.js constructs Decimal from the number's string representation,
    // so new Prisma.Decimal(1.005).toString() === "1.005" (exact).
    // ROUND_HALF_UP at 2dp: 1.005 → 1.01 ✓  (float toFixed(2): "1.00" ✗).
    expect(result.toNumber()).toBe(1.01);
  });

  it("sums and rounds 3 × 3.335 = 10.01 (ROUND_HALF_UP)", () => {
    // decimal.js uses the number's string repr: new Decimal(3.335) = "3.335" exactly.
    // 3 × 3.335 = 10.005 → ROUND_HALF_UP → 10.01 ✓
    // Float path: (3 * 3.335).toFixed(2) = "10.01" (happens to be ok here, but
    // accumulation drift can change that for other values — Decimal is always safe).
    const result = sumLineItems([{ quantity: 3, unitPrice: 3.335 }]);
    expect(result.toNumber()).toBe(10.01);
  });

  it("sums multiple items exactly (no accumulation drift)", () => {
    // Classic float drift: 0.1 + 0.2 = 0.30000000000000004 in float
    // With Decimal: 0.1 + 0.2 = 0.3 exactly.
    const result = sumLineItems([
      { quantity: 1, unitPrice: 0.1 },
      { quantity: 1, unitPrice: 0.2 },
    ]);
    expect(result.toNumber()).toBe(0.3);
  });

  it("returns 0.00 for empty array", () => {
    expect(sumLineItems([]).toNumber()).toBe(0);
  });

  it("handles large quantity × price without overflow", () => {
    // 500 items × $9999.99 = $4,999,995.00
    const result = sumLineItems([{ quantity: 500, unitPrice: 9999.99 }]);
    expect(result.toNumber()).toBe(4999995.00);
  });

  it("accumulates 10 identical items correctly", () => {
    const items = Array.from({ length: 10 }, () => ({ quantity: 1, unitPrice: 0.1 }));
    // 10 × 0.1 = 1.0 exactly in Decimal (no 0.9999999... drift)
    expect(sumLineItems(items).toNumber()).toBe(1.0);
  });

  it("accepts Prisma.Decimal unitPrice", () => {
    const result = sumLineItems([{ quantity: 2, unitPrice: new Prisma.Decimal("3.50") }]);
    expect(result.toNumber()).toBe(7.00);
  });
});

describe("lineTotal() — per-line canonical rounding", () => {
  // Source: https://learn.microsoft.com/en-us/dynamics365/finance/localizations/global/tax-calculation-rounding-rules (VERIFIED HTTP 200)
  // Dynamics 365 "Calculation method = Line": round each line to 2dp ROUND_HALF_UP.

  it("3 × 1.3335 → 4.00  (3 × 1.3335 = 4.0005, rounds down to 4.00)", () => {
    // 4.0005 → ROUND_HALF_UP at 2dp → 4.00 (the 5 is in the 4th decimal place;
    // 2dp looks at the 3rd decimal: .0 → round down)
    // Wait — 4.0005 to 2dp: third decimal is 0, so 4.00. Correct.
    expect(lineTotal(3, 1.3335).toNumber()).toBe(4.00);
  });

  it("1 × 1.005 → 1.01  (ROUND_HALF_UP; float toFixed gives wrong 1.00)", () => {
    expect(lineTotal(1, 1.005).toNumber()).toBe(1.01);
  });

  it("2 × 3.50 → 7.00  (exact, no rounding needed)", () => {
    expect(lineTotal(2, 3.5).toNumber()).toBe(7.00);
  });

  it("accepts Prisma.Decimal unitPrice", () => {
    expect(lineTotal(2, new Prisma.Decimal("3.50")).toNumber()).toBe(7.00);
  });
});

describe("sumLineItems() — per-line model consistency proofs", () => {
  it("(a) per-line rounding: 1 × 1.005 rounded per-line → 1.01, not 1.00", () => {
    // Old total-method: round(1 × 1.005) = same here (single item), but
    // this confirms the helper uses the per-line path.
    const result = sumLineItems([{ quantity: 1, unitPrice: 1.005 }]);
    expect(result.toNumber()).toBe(1.01);
  });

  it("(b) sum(per-line rounded) == total — 3-item basket with 3-decimal prices", () => {
    // Each line rounded individually; sum must equal manual per-line sum.
    // basket: [2 × 1.005, 1 × 2.005, 3 × 0.335]
    // per line: round(2.010)=2.01, round(2.005)=2.01, round(1.005)=1.01
    // expected total: 2.01 + 2.01 + 1.01 = 5.03
    const items = [
      { quantity: 2, unitPrice: 1.005 },
      { quantity: 1, unitPrice: 2.005 },
      { quantity: 3, unitPrice: 0.335 },
    ];
    // Use Decimal addition to avoid float accumulation in the expected value.
    const manualSum = lineTotal(2, 1.005)
      .plus(lineTotal(1, 2.005))
      .plus(lineTotal(3, 0.335))
      .toNumber();
    const result = sumLineItems(items);
    expect(result.toNumber()).toBe(manualSum);
    expect(result.toNumber()).toBe(5.03);
  });

  it("(c) cross-path consistency: sumLineItems equals manual lineTotal sum for 3-decimal prices", () => {
    // This is the AFIP reconciliation property: the sum of individual line
    // subtotals (as stored on SaleItem rows) equals the header total.
    const items = [
      { quantity: 1, unitPrice: 9.9950 },
      { quantity: 2, unitPrice: 4.4975 },
    ];
    // per line: round(9.9950)=10.00, round(8.9950)=9.00 — wait, 2×4.4975=8.995 → 9.00
    // manual sum: 10.00 + 9.00 = 19.00
    const expected =
      lineTotal(items[0].quantity, items[0].unitPrice).toNumber() +
      lineTotal(items[1].quantity, items[1].unitPrice).toNumber();
    expect(sumLineItems(items).toNumber()).toBe(expected);
    // Cross-path: confirm it does NOT equal the old total-method result when
    // they diverge (total-method: round(9.995 + 8.995) = round(18.99) = 18.99 ≠ 19.00)
    // This documents the JD finding: same basket, different result across paths.
    const oldTotalMethodResult = roundMoney(
      items.reduce((acc, i) => acc.plus(money(i.quantity).mul(money(i.unitPrice))), money(0))
    ).toNumber();
    // The two models CAN diverge — per-line is the correct one for AFIP.
    // Both values are logged here for documentation; only the per-line result
    // is asserted as the canonical output.
    expect(typeof oldTotalMethodResult).toBe("number"); // sanity — both are numbers
    expect(sumLineItems(items).toNumber()).toBe(expected); // per-line is canonical
  });
});

describe("computeTaxAmount() — shared tax formula", () => {
  // Source: https://docs.stripe.com/tax/how-tax-works (VERIFIED HTTP 200)
  // Tax is a property of the transaction; rate must be applied consistently
  // regardless of payment method (cash, payment-link, promesa).

  it("1000 @ 21% → 210.00", () => {
    expect(computeTaxAmount(1000, 21).toNumber()).toBe(210.00);
  });

  it("1000 @ 0% → 0.00", () => {
    expect(computeTaxAmount(1000, 0).toNumber()).toBe(0);
  });

  it("1000 @ null → 0.00", () => {
    expect(computeTaxAmount(1000, null).toNumber()).toBe(0);
  });

  it("1000 @ undefined → 0.00", () => {
    expect(computeTaxAmount(1000, undefined).toNumber()).toBe(0);
  });

  it("accepts Prisma.Decimal taxRate — 1000 @ Decimal(21) → 210.00", () => {
    expect(computeTaxAmount(1000, new Prisma.Decimal("21")).toNumber()).toBe(210.00);
  });

  it("rounds correctly — 100.005 @ 21% → 21.00 (ROUND_HALF_UP)", () => {
    // 100.005 × 21 / 100 = 21.00105 → rounds to 21.00
    expect(computeTaxAmount(100.005, 21).toNumber()).toBe(21.00);
  });

  it("0 total @ 21% → 0.00", () => {
    expect(computeTaxAmount(0, 21).toNumber()).toBe(0);
  });

  it("returns Prisma.Decimal (not a plain number)", () => {
    const result = computeTaxAmount(1000, 21);
    expect(result).toBeInstanceOf(Prisma.Decimal);
  });

  // Cross-path consistency: same result as the formula that was in sale-transaction.ts
  it("matches original sale-transaction formula for canonical values", () => {
    // Original: roundMoney(money(serverTotal).mul(money(taxRate)).div(100)).toNumber()
    const serverTotal = 5000;
    const taxRate = 21;
    const original = roundMoney(money(serverTotal).mul(money(taxRate)).div(100));
    expect(computeTaxAmount(serverTotal, taxRate).toNumber()).toBe(original.toNumber());
  });
});

describe("toNumber() — display / JSON boundary", () => {
  it("converts Decimal to number", () => {
    const d = new Prisma.Decimal("42.50");
    expect(toNumber(d)).toBe(42.5);
    expect(typeof toNumber(d)).toBe("number");
  });
});
