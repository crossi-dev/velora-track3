// Business rules for sales — pure functions, no UI, no framework dependencies

// Hard block — sale total must be > 0
export function validateSaleTotal(total: number): string | null {
  if (total <= 0) return "Sale total must be greater than zero.";
  return null;
}

// Per-business configurable — use Business.priceOutlierThreshold once field is added to schema.
export const DEFAULT_PRICE_OUTLIER_THRESHOLD = 0.5;

// Hard block for employees, soft warning for owner
export function detectPriceOutlier(
  entered: number,
  catalog: number,
  threshold: number,
): { direction: "above" | "below"; expected: number } | null {
  if (!Number.isFinite(entered) || !Number.isFinite(catalog)) return null;
  if (entered <= 0 || catalog <= 0) return null;
  const deviation = (entered - catalog) / catalog;
  if (Math.abs(deviation) <= threshold) return null;
  return { direction: deviation > 0 ? "above" : "below", expected: catalog };
}

// Hard block for all — cannot sell more than available stock
export function detectStockShortfall(
  requested: number,
  available: number,
): { available: number; requested: number } | null {
  if (!Number.isFinite(requested) || !Number.isFinite(available)) return null;
  if (requested <= available) return null;
  return { available, requested };
}

// Hard block — sale must have at least one item
export function validateSaleItems(items: { quantity: number }[]): string | null {
  if (!items || items.length === 0) return "A sale must have at least one item.";
  return null;
}

// Hard block — each item quantity must be a positive integer (DB schema uses Int)
export function validateSaleItemQuantity(quantity: number): string | null {
  if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isInteger(quantity)) return "Item quantity must be a positive whole number.";
  return null;
}
