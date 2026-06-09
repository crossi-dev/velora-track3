// money.ts — Exact decimal arithmetic helpers for monetary values.
//
// Problem: JavaScript IEEE-754 float arithmetic produces rounding errors for
// money (e.g. (1.005).toFixed(2) === "1.00" instead of "1.01"). Custom
// roundMoney(v) = Number(v.toFixed(2)) duplicated across the codebase
// inherits that bug.
//
// Solution: Prisma already bundles decimal.js as Prisma.Decimal — no new
// dependency. All money arithmetic uses Decimal internally; only convert to
// Number at JSON / display boundaries, never for arithmetic.
//
// Rounding model: PER-LINE rounding (a.k.a. "Calculation method = Line").
// Each line total (quantity × unitPrice) is rounded to 2dp ROUND_HALF_UP
// independently; the invoice/sale total is the exact sum of those rounded
// line values. This guarantees sum(line subtotals) == header total, which
// is the AFIP reconciliation requirement and standard ERP behaviour.
//
// Source: https://learn.microsoft.com/en-us/dynamics365/finance/localizations/global/tax-calculation-rounding-rules
//   (VERIFIED HTTP 200) — Dynamics 365 "Calculation method = Line": round each
//   line, then sum. Rounding mode ROUND_HALF_UP, 2 decimals (ISO 80000-1).
// Source: https://mikemcl.github.io/decimal.js/ (VERIFIED HTTP 200)
//   "Decimal.ROUND_HALF_UP: Rounds towards nearest neighbour. If equidistant,
//    rounds away from zero."  — the standard banker expectation for retail money.
// Source: https://www.postgresql.org/docs/current/datatype-numeric.html (VERIFIED HTTP 200)
//   "If you require exact storage and calculations (such as for monetary
//    amounts), use the numeric type instead."

import { Prisma } from "@prisma/client";

// ── Constructors ─────────────────────────────────────────────────────────────

/**
 * Wrap any numeric input (number | string | Prisma.Decimal) as a Prisma.Decimal.
 * This is the preferred entry-point for raw inputs that arrive as JS numbers —
 * convert them once at the boundary, then keep as Decimal throughout.
 *
 * @example money(item.unitPrice)        // number → Decimal
 * @example money("1.005")              // string → Decimal (no float parse error)
 * @example money(existingDecimal)      // Decimal → Decimal (no-op copy)
 */
export function money(value: number | string | Prisma.Decimal): Prisma.Decimal {
  return new Prisma.Decimal(value);
}

// ── Rounding ─────────────────────────────────────────────────────────────────

/**
 * Round a Decimal to 2 decimal places using ROUND_HALF_UP.
 * Use for final stored values and display totals.
 *
 * Why ROUND_HALF_UP: consistent with AR fiscal rounding (ARCA RG 4291) and
 * standard retail POS behaviour. Avoids banker's rounding surprise at 0.005.
 *
 * @example roundMoney(money("1.005"))  // → Decimal("1.01") ✓  (float: "1.00" ✗)
 * @example roundMoney(money("1.004"))  // → Decimal("1.00") ✓
 */
export function roundMoney(value: Prisma.Decimal | number | string): Prisma.Decimal {
  return new Prisma.Decimal(value).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
}

// ── Aggregation ──────────────────────────────────────────────────────────────

/**
 * Compute a single invoice line total: quantity × unitPrice, rounded to 2dp
 * ROUND_HALF_UP. This is the canonical per-line rounding unit — use it
 * everywhere a line subtotal is computed (sale create, invoice builder,
 * payment-link use-case) so all paths produce the same value.
 *
 * Per-line rounding model (Dynamics 365 "Calculation method = Line"):
 * each line is rounded individually; the header total is the exact sum of
 * the already-rounded lines. This guarantees sum(line subtotals) == header
 * total and satisfies the AFIP reconciliation requirement.
 *
 * Source: https://learn.microsoft.com/en-us/dynamics365/finance/localizations/global/tax-calculation-rounding-rules (VERIFIED HTTP 200)
 * Source: https://mikemcl.github.io/decimal.js/ (VERIFIED HTTP 200)
 *
 * @example lineTotal(3, 1.3335)  // → Decimal("4.00")  (3 × 1.3335 = 4.0005 → 4.00)
 * @example lineTotal(1, 1.005)   // → Decimal("1.01")  (float toFixed: "1.00" ✗)
 */
export function lineTotal(
  quantity: number,
  unitPrice: number | Prisma.Decimal
): Prisma.Decimal {
  return new Prisma.Decimal(quantity)
    .mul(new Prisma.Decimal(unitPrice))
    .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
}

/**
 * Sum an array of line items using the per-line rounding model.
 * Each line (quantity × unitPrice) is rounded to 2dp ROUND_HALF_UP first,
 * then the rounded line totals are summed exactly — no second round.
 *
 * This guarantees the result equals sum(lineTotal(item)) for every item,
 * which means invoice line subtotals always add up to the header total.
 *
 * @example sumLineItems([{ quantity: 3, unitPrice: 3.335 }])
 *          // line → 10.005 → 10.01; sum of [10.01] = Decimal("10.01") ✓
 * @example sumLineItems([{ quantity: 1, unitPrice: 1.005 }])
 *          // → Decimal("1.01") ✓  (float toFixed(2): "1.00" ✗)
 */
export function sumLineItems(
  items: ReadonlyArray<{ quantity: number; unitPrice: number | Prisma.Decimal }>
): Prisma.Decimal {
  // Round each line first (per-line model), then sum the rounded values.
  // No second round — the sum of 2dp values is already exact.
  return items.reduce((acc, item) => {
    return acc.add(lineTotal(item.quantity, item.unitPrice));
  }, new Prisma.Decimal(0));
}

// ── Tax ──────────────────────────────────────────────────────────────────────

/**
 * Compute the tax amount for a sale: total × (taxRate / 100), rounded to 2dp
 * ROUND_HALF_UP. Returns 0.00 when taxRate is 0 or falsy.
 *
 * Tax is a property of the transaction and must be computed consistently
 * regardless of payment method (cash, payment-link, promesa). This is the
 * single authoritative formula for all sale paths in Velora.
 *
 * Source: https://docs.stripe.com/tax/how-tax-works (VERIFIED HTTP 200)
 *   "Tax is calculated on the transaction total at the point of sale."
 *   Stripe applies the same rate regardless of payment method — card, bank
 *   transfer, or any other instrument. This helper mirrors that model.
 *
 * Source: https://mikemcl.github.io/decimal.js/ (VERIFIED HTTP 200)
 *   Decimal arithmetic with ROUND_HALF_UP avoids IEEE-754 drift on the
 *   multiplication and division (e.g. 1000.005 × 21 / 100 = 210.00105 → 210.00).
 *
 * @param total    - Sale total (number at the boundary — converted to Decimal internally)
 * @param taxRate  - Business taxRate from DB (Prisma.Decimal | number | null | undefined).
 *                   Treated as a percentage (e.g. 21 → 21%). Returns 0.00 if falsy.
 * @returns Prisma.Decimal — keep as Decimal for arithmetic; call .toNumber() only
 *          at the DB write boundary.
 *
 * @example computeTaxAmount(1000, 21)    // → Decimal("210.00")
 * @example computeTaxAmount(1000, 0)     // → Decimal("0.00")
 * @example computeTaxAmount(1000, null)  // → Decimal("0.00")
 */
export function computeTaxAmount(
  total: number,
  taxRate: Prisma.Decimal | number | null | undefined
): Prisma.Decimal {
  if (taxRate == null) return new Prisma.Decimal(0);
  const rate =
    typeof taxRate === "object" && "toNumber" in taxRate
      ? taxRate.toNumber()
      : Number(taxRate);
  if (!Number.isFinite(rate) || rate <= 0) return new Prisma.Decimal(0);
  // total × rate / 100, rounded ROUND_HALF_UP to 2dp
  return roundMoney(money(total).mul(money(rate)).div(100));
}

// ── Conversion (use ONLY at JSON / display boundaries) ───────────────────────

/**
 * Convert a Decimal to a plain JS number for JSON serialisation or display.
 * Do NOT use the result for further arithmetic — convert back to Decimal first.
 */
export function toNumber(value: Prisma.Decimal): number {
  return value.toNumber();
}
