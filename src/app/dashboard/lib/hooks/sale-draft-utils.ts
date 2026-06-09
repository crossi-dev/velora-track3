/**
 * Pure utility functions and constants for the sale draft assistant.
 * No React hooks — only stateless helpers.
 */

/* ------------------------------------------------------------------ */
/*  LocalStorage keys                                                 */
/* ------------------------------------------------------------------ */

export const GENERIC_SALE_DRAFT_KEY = "velora-sale-draft";
export const GENERIC_PENDING_SALE_FLOW_KEY = "velora-pending-sale-flow";

/* ------------------------------------------------------------------ */
/*  LocalStorage helpers                                              */
/* ------------------------------------------------------------------ */

export function readPersistedJson<T>(key: string): T | null {
  if (typeof window === "undefined") return null;
  try {
    const saved = localStorage.getItem(key);
    return saved ? (JSON.parse(saved) as T) : null;
  } catch {
    return null;
  }
}

export function persistJson<T>(key: string, value: T | null): void {
  if (typeof window === "undefined") return;
  if (value === null) {
    localStorage.removeItem(key);
    return;
  }
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (err) {
    console.error(
      `[sale-draft] No se pudo guardar "${key}" en localStorage (cuota excedida).`,
      err
    );
  }
}

/* ------------------------------------------------------------------ */
/*  Scoped key builders                                               */
/* ------------------------------------------------------------------ */

export function scopedKey(generic: string, businessId: string | null): string {
  return businessId ? `${generic}:${businessId}` : generic;
}
