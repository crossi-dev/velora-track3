export interface LowStockDismissibleProduct {
  id: string;
  stock: number;
}

export const LOW_STOCK_DISMISSALS_STORAGE_KEY = "velora-inventory-dismissed-low-stock";

export function buildLowStockDismissalKey(product: LowStockDismissibleProduct): string {
  return `${product.id}:${Number(product.stock)}`;
}

export function pruneDismissedLowStockKeys(
  dismissedKeys: Iterable<string>,
  lowStockProducts: LowStockDismissibleProduct[]
): string[] {
  const validKeys = new Set(lowStockProducts.map(buildLowStockDismissalKey));
  const nextKeys = new Set<string>();

  for (const key of dismissedKeys) {
    if (validKeys.has(key)) {
      nextKeys.add(key);
    }
  }

  return [...nextKeys];
}

export function parseDismissedLowStockKeys(
  rawValue: string | null,
  lowStockProducts: LowStockDismissibleProduct[]
): string[] {
  if (!rawValue) {
    return [];
  }

  try {
    const parsed = JSON.parse(rawValue);
    if (!Array.isArray(parsed)) {
      return [];
    }

    const stringKeys = parsed.filter((value): value is string => typeof value === "string");
    return pruneDismissedLowStockKeys(stringKeys, lowStockProducts);
  } catch {
    return [];
  }
}
