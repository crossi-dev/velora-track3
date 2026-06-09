import type { SaleRecord } from "./types";
import { tLang } from "./DashboardLangContext";

// Window within which a matching sale is flagged as a likely duplicate.
// 60s matches the common "accidental double-submit" pattern (user
// presses Confirmar twice, or voices the same phrase after a transient
// UI glitch). Deliberately shorter than typical sale-rhythm gaps so
// legitimate back-to-back sales of the same thing aren't flagged.
export const DUPLICATE_SALE_WINDOW_MS = 60_000;

export interface DuplicateSaleCandidate {
  customerId: string | null;
  items: { productId: string | null; quantity: number }[];
}

// Returns the most recent SaleRecord within `windowMs` whose customer +
// item multiset matches the candidate, or null if no duplicate is
// suspected. Match rule: (a) same customerId (both null counts as a
// match for walk-in sales), (b) same set of (productId, quantity)
// pairs regardless of order. Unresolved candidate items (productId=null)
// skip the check — a half-parsed draft shouldn't fire false positives.
export function findRecentDuplicateSale(
  sales: SaleRecord[],
  candidate: DuplicateSaleCandidate,
  nowMs: number,
  windowMs: number = DUPLICATE_SALE_WINDOW_MS
): SaleRecord | null {
  if (sales.length === 0) return null;

  // Only compare the resolved-item subset. A draft with some unresolved items
  // (productId === null) still participates in duplicate detection for the
  // items that did resolve. Bail only when nothing resolved at all.
  const candidateItems = candidate.items
    .filter((i): i is { productId: string; quantity: number } => typeof i.productId === "string" && i.productId.length > 0)
    .map((i) => ({ productId: i.productId, quantity: i.quantity }));
  if (candidateItems.length === 0) return null;

  const candidateSorted = [...candidateItems].sort((a, b) => a.productId.localeCompare(b.productId));

  for (const sale of sales) {
    const saleMs = Date.parse(sale.date);
    if (!Number.isFinite(saleMs)) continue;
    const age = nowMs - saleMs;
    if (age < 0 || age > windowMs) continue;

    const saleCustomerId = sale.customer?.id ?? null;
    if (saleCustomerId !== candidate.customerId) continue;

    if (sale.items.length !== candidateSorted.length) continue;

    const saleSorted = [...sale.items]
      .map((i) => ({ productId: i.product.id, quantity: i.quantity }))
      .sort((a, b) => a.productId.localeCompare(b.productId));

    const match = candidateSorted.every(
      (c, i) => saleSorted[i].productId === c.productId && saleSorted[i].quantity === c.quantity,
    );
    if (match) return sale;
  }
  return null;
}

// Builds the transient-reply string shown when a duplicate is suspected.
// Exported for testing so assertions don't need to re-implement the
// format. Clamps to 1s minimum so "hace 0s" never shows.
export function buildDuplicateSaleWarning(sale: SaleRecord, nowMs: number): string {
  const ageMs = Math.max(1000, nowMs - Date.parse(sale.date));
  const seconds = Math.round(ageMs / 1000);
  return tLang(`⚠ ${seconds}s ago you registered an identical sale. Review the draft before confirming.`, `⚠ Hace ${seconds}s registraste una venta igual. Revisá el borrador antes de confirmar.`);
}

export function buildDuplicateAttemptWarning(ageMs: number): string {
  const clamped = Math.max(1000, ageMs);
  const seconds = Math.round(clamped / 1000);
  return tLang(`⚠ ${seconds}s ago you registered an identical sale. Review the draft before confirming.`, `⚠ Hace ${seconds}s registraste una venta igual. Revisá el borrador antes de confirmar.`);
}

// ── In-memory attempt buffer ──────────────────────────────────────
//
// ctx.sales is the server-persisted sales list; it refreshes
// asynchronously via loadBusiness({silent:true}) after a commit. Between
// the commit returning and the refresh landing there's a window where
// the list is stale. Without an in-memory buffer, a user who rapidly
// repeats a sale (e.g., "vendí 2 yerbas a carlos" twice within seconds)
// slips past the duplicate guard because ctx.sales hasn't caught up.
//
// This buffer records every register_sale dispatch attempt the moment
// it happens, client-side. Cleared on page refresh; 60s window so stale
// entries don't accumulate. Module-level because the dispatcher is a
// top-level async function without an owning component.

interface SaleAttempt {
  timestamp: number;
  customerId: string | null;
  items: { productId: string; quantity: number }[];
}

const recentAttempts: SaleAttempt[] = [];

// Trim entries older than 2× window to keep the list bounded without
// discarding entries that might still be relevant at the exact boundary.
function trimExpired(nowMs: number, windowMs: number) {
  const cutoff = nowMs - windowMs * 2;
  while (recentAttempts.length > 0 && recentAttempts[0].timestamp < cutoff) {
    recentAttempts.shift();
  }
}

export function recordSaleAttempt(
  candidate: DuplicateSaleCandidate,
  nowMs: number,
  windowMs: number = DUPLICATE_SALE_WINDOW_MS,
): void {
  // Only record resolved items; bail if none resolved.
  const items = candidate.items
    .filter((i): i is { productId: string; quantity: number } => typeof i.productId === "string" && i.productId.length > 0)
    .map((i) => ({ productId: i.productId, quantity: i.quantity }));
  if (items.length === 0) return;
  recentAttempts.push({ timestamp: nowMs, customerId: candidate.customerId, items });
  trimExpired(nowMs, windowMs);
}

// Returns the most recent in-memory attempt within `windowMs` that
// matches the candidate's customer + items multiset. Same match rule
// as findRecentDuplicateSale so the two sources are interchangeable.
export function findRecentAttemptDuplicate(
  candidate: DuplicateSaleCandidate,
  nowMs: number,
  windowMs: number = DUPLICATE_SALE_WINDOW_MS,
): SaleAttempt | null {
  // Compare resolved-item subset only (same rule as findRecentDuplicateSale).
  const candidateItems = candidate.items
    .filter((i): i is { productId: string; quantity: number } => typeof i.productId === "string" && i.productId.length > 0)
    .map((i) => ({ productId: i.productId, quantity: i.quantity }));
  if (candidateItems.length === 0) return null;

  const candidateSorted = [...candidateItems].sort((a, b) => a.productId.localeCompare(b.productId));

  for (let i = recentAttempts.length - 1; i >= 0; i--) {
    const attempt = recentAttempts[i];
    const age = nowMs - attempt.timestamp;
    if (age < 0 || age > windowMs) continue;
    if (attempt.customerId !== candidate.customerId) continue;
    if (attempt.items.length !== candidateSorted.length) continue;
    const attemptSorted = [...attempt.items].sort((a, b) => a.productId.localeCompare(b.productId));
    const match = candidateSorted.every(
      (c, idx) => attemptSorted[idx].productId === c.productId && attemptSorted[idx].quantity === c.quantity,
    );
    if (match) return attempt;
  }
  return null;
}

// Reset hook for tests. Never call from application code.
export function _resetSaleAttemptsForTests(): void {
  recentAttempts.length = 0;
}
