/**
 * H-3 money-safety guard for the supervisor action mapper.
 *
 * Cross-checks LLM-emitted unitPrice on register_sale actions against the
 * business catalog. If the price deviates from catalog and the owner's raw
 * message text contains no explicit price, the LLM value is stripped to
 * prevent hallucinated sale amounts from executing.
 *
 * RESIDUAL (as of 2026-06-03): saleDraft.items[].unitPrice (extractSaleDraft /
 * resolvePrice) is a second price-injection path NOT covered here — it accepts
 * LLM-emitted prices via the same logic and needs the draft→approve gate to be
 * fully safe. This guard covers the CompoundAction.unitPrice → priceOverride path.
 *
 * Token-match logic lives in src/lib/money/user-typed-amount.ts (shared with
 * agent-factory.seams.ts) so the algorithm has a single source of truth.
 */
import { cloudLog } from "@/lib/cloud-logger";
import {
  PRICE_DEVIATION_TOLERANCE,
  userTypedThisAmount,
} from "@/lib/money/user-typed-amount";

// The guard's real question is: "did the owner authorise THIS price?" The
// previous regex tried to detect *whether* the text contained any price-looking
// number — and jd/supervisor-h3-money-guard proved that's unsafe: its
// `\b\d{2,}\b` branch matched QUANTITIES ("vendé 2500 alfajores"), disabling the
// guard on the most common B2B phrasing so an LLM-invented price would ship; and
// its `\$` was an end-anchor, not a literal "$".
//
// Correct discriminator: compare the LLM's emitted unitPrice against the numbers
// the owner LITERALLY wrote. The price is honoured only if the owner typed that
// exact value. A quantity ("2500 alfajores") never equals an invented price (1),
// so the guard strips it. A real owner price ("vendé tuercas a 3000") matches the
// token 3000, so it passes. Word-numbers ("tres lucas") and relative prices
// ("al doble") don't match → guard strips → real catalog price + the sale
// confirmation modal as the human backstop (the SAFE direction).
//
// ownerNumericTokens + ownerStatedThisPrice are now in user-typed-amount.ts.
// See that module for the full round-by-round algorithm history.

// Thin local alias so call sites in this file remain unchanged.
function ownerStatedThisPrice(
  rawOwnerText: string,
  unitPrice: number,
  qty: number | undefined,
): boolean {
  return userTypedThisAmount(rawOwnerText, unitPrice, qty);
}

function toCatalogPrice(raw: number | string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  const parsed = Number.parseFloat(String(raw).replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
}

type GuardableProduct = { id: string; name: string; price?: number | string | null };

/**
 * Returns the validated unitPrice to use on the CompoundAction, or undefined
 * if the LLM-emitted value should be dropped.
 *
 * Drops unitPrice when ALL of:
 *   1. unitPrice is present and non-negative
 *   2. The product has a catalog price
 *   3. The LLM price deviates from the catalog price by > 1 %
 *   4. The owner's raw text contains no explicit numeric price
 */
export function guardSaleUnitPrice(
  rawUnitPrice: unknown,
  product: GuardableProduct | undefined,
  rawOwnerText: string,
  qty?: number,
): number | undefined {
  const unitPrice = typeof rawUnitPrice === "number" && rawUnitPrice >= 0 ? rawUnitPrice : undefined;
  if (unitPrice === undefined || !product) return unitPrice;

  const catalogPrice = toCatalogPrice(product.price);
  if (catalogPrice === null || catalogPrice <= 0) return unitPrice;

  const deviation = Math.abs(unitPrice - catalogPrice) / catalogPrice;
  if (deviation <= PRICE_DEVIATION_TOLERANCE || ownerStatedThisPrice(rawOwnerText, unitPrice, qty)) {
    return unitPrice;
  }

  cloudLog({
    severity: "WARNING",
    component: "Supervisor",
    action: "MONEY_GUARD_PRICE_DEVIATION",
    a2a_transfer: false,
    message: "register_sale: LLM-emitted unitPrice deviates from catalog price with no explicit price in owner text — stripping to prevent hallucinated sale amount",
    data: {
      productId: product.id,
      productName: product.name,
      llmUnitPrice: unitPrice,
      catalogPrice,
      deviationPct: Math.round(deviation * 100),
      rawOwnerTextPreview: rawOwnerText.slice(0, 120),
    },
  });
  return undefined;
}
