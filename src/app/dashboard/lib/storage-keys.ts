// Centralised localStorage / sessionStorage keys used across the dashboard.
// Co-locating prevents typos in `getItem` / `setItem` calls from drifting
// out of sync with their writers — a common source of "settings keep
// resetting" bugs when one site uses the new name and another the old.

export const STORAGE_KEY = {
  /** Per-user dashboard settings (theme, voice prefs, etc). */
  APP_SETTINGS: "velora-app-settings",
  /** Set of notification keys the user has acknowledged in-session. */
  SEEN_NOTIFICATIONS: "velora-seen-notifications",
  /** Set of notification IDs the user has dismissed. */
  DISMISSED_NOTIFICATIONS: "velora-dismissed-notifications",
  /** Session-only flag that the fiscal-warning banner was dismissed. */
  FISCAL_WARNING_DISMISSED: "velora:fiscal-warning-dismissed",
} as const;

/**
 * Returns the sessionStorage key for a fresh employee PIN.
 * Stored only for the current browser session; cleared after first reveal.
 * Never persisted to localStorage or the DB.
 */
export function freshPinKey(employeeId: string): string {
  return `velora.fresh_pin.${employeeId}`;
}

export type StorageKey = typeof STORAGE_KEY[keyof typeof STORAGE_KEY];
