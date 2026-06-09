import { tLang } from "../DashboardLangContext";
import type { Product } from "../types";
import type { VeloraSingleCommand } from "./shared";

// Matches read-only "what's running low?" queries. No product name
// required — the answer is always a filtered list of the whole catalog.
// Conservative patterns: bare keywords plus a small number of natural
// Argentine phrasings ("qué me está por faltar", "productos bajos").
const LOW_STOCK_PATTERNS: RegExp[] = [
  // Request-prefixed: "decime / dame / mostrame (los) productos bajos"
  /^(?:decime|deci|dame|mostrame|mostra|listame|lista|fijate|a\s+ver)\s+(?:los\s+|las\s+|el\s+|la\s+)?(?:productos?\s+(?:bajos?|con\s+(?:poco|bajo)\s+stock)|stock\s+(?:bajo|minimo)|(?:poco|bajo)\s+stock|que\s+(?:falta|me\s+falta))\??$/,
  // Bare: "productos bajos" / "poco stock" / "stock bajo" / "stock mínimo"
  /^(?:productos?\s+(?:bajos?|con\s+(?:poco|bajo)\s+stock)|stock\s+(?:bajo|minimo)|(?:poco|bajo)\s+stock)\??$/,
  // "qué (productos) me está(n) por faltar" / "qué (me) falta"
  /^que\s+(?:me\s+)?(?:(?:productos?\s+)?(?:esta|estan)\s+por\s+faltar|falta(?:n)?)\??$/,
  // "qué productos tengo (con poco) bajo(s)"
  /^que\s+productos\s+tengo\s+(?:con\s+poco\s+stock|(?:con\s+)?bajo(?:s)?)\??$/,
];

export type LowStockQueryData = Record<string, never>;

export function detectLowStockQuery(normalized: string): VeloraSingleCommand | null {
  for (const pattern of LOW_STOCK_PATTERNS) {
    if (pattern.test(normalized)) {
      return { matched: true, intent: "low_stock_query", data: {} };
    }
  }
  return null;
}

export const DEFAULT_LOW_STOCK_THRESHOLD = 5;

export function findLowStockProducts(
  products: Product[],
  threshold: number = DEFAULT_LOW_STOCK_THRESHOLD
): Product[] {
  return products
    .filter((p) => {
      const limit = p.reorderThreshold ?? threshold;
      return Number.isFinite(p.stock) && p.stock < limit;
    })
    .sort((a, b) => a.stock - b.stock);
}

export function buildLowStockReply(lowStock: Product[]): string {
  if (lowStock.length === 0) {
    return tLang("No products with low stock.", "No hay productos con poco stock.");
  }
  const MAX = 10;
  const shown = lowStock.slice(0, MAX);
  const lines = shown.map((p) => {
    const unit = p.stock === 1 ? tLang("unit", "unidad") : tLang("units", "unidades");
    return `• ${p.name} — ${p.stock} ${unit}`;
  });
  const header = tLang(`Low stock products (${lowStock.length}):`, `Productos con poco stock (${lowStock.length}):`);
  const footer = lowStock.length > MAX ? tLang(`\n…and ${lowStock.length - MAX} more.`, `\n…y ${lowStock.length - MAX} más.`) : "";
  return `${header}\n${lines.join("\n")}${footer}`;
}
