import { tLang } from "./DashboardLangContext";

// Voice-trained catalog — single-unknown pending state.
//
// When register_sale parses a phrase where ONE item has no catalog
// match (e.g., "vendí 2 fernet a juan" and fernet isn't in the
// catalog), instead of falling through to the AI we pause the sale,
// ask the user for the product's price, create the product on their
// reply, then re-dispatch the original sale phrase so the parser picks
// up the newly-created product.
//
// Pending state lives at module scope (client-side only). Cleared on
// page refresh or after a 5-minute timeout.

const PENDING_TIMEOUT_MS = 5 * 60 * 1000;

export interface PendingUnknownProductSale {
  productName: string;
  saleText: string;
  timestamp: number;
}

let pending: PendingUnknownProductSale | null = null;

export function setPendingUnknownProduct(data: Omit<PendingUnknownProductSale, "timestamp">): void {
  pending = { ...data, timestamp: Date.now() };
}

export function getPendingUnknownProduct(): PendingUnknownProductSale | null {
  if (!pending) return null;
  if (Date.now() - pending.timestamp > PENDING_TIMEOUT_MS) {
    pending = null;
    return null;
  }
  return pending;
}

export function clearPendingUnknownProduct(): void {
  pending = null;
}

// Reset hook for tests. Never call from application code.
export function _resetPendingUnknownProductForTests(): void {
  pending = null;
}

// Parses a bare price response like "2500", "$2500", "2500 pesos",
// "a 2500". Returns the numeric value or null. Used only when a
// pending unknown-product state is active, so ambiguous short numeric
// inputs don't trigger this everywhere.
export function parsePriceResponse(normalized: string): number | null {
  const trimmed = normalized.trim();
  if (!trimmed) return null;
  // Match: optional "a/por/en" prefix, optional $, digits, optional "pesos"
  const match = trimmed.match(/^(?:a\s+|por\s+|en\s+)?\$?\s*(\d{1,9})\s*(?:pesos?)?\s*\??$/);
  if (!match) return null;
  const value = Number.parseInt(match[1], 10);
  if (!Number.isFinite(value) || value <= 0) return null;
  return value;
}

export function buildUnknownProductQuestion(productName: string): string {
  return tLang(`I don't know "${productName}". What's the price?`, `No conozco "${productName}". ¿Cuál es el precio?`);
}
