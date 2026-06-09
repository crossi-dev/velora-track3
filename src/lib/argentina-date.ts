/**
 * Argentina date helpers — Intl-based, DST-safe.
 *
 * All helpers derive the Argentina calendar day (America/Argentina/Buenos_Aires)
 * via Intl.DateTimeFormat so they remain correct regardless of the runtime's
 * local timezone (Cloud Run runs in UTC; dev machines may differ).
 *
 * Source: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/DateTimeFormat/DateTimeFormat
 * (VERIFIED HTTP 200, 2026-06-07)
 *
 * Argentina abolished DST in 2009 and has been on permanent UTC-3 since.
 * IANA timezone: America/Argentina/Buenos_Aires.
 */

export const ARGENTINA_TZ = "America/Argentina/Buenos_Aires";

// ART is fixed UTC-3 — one ART calendar day occupies
// [YYYY-MM-DD 03:00 UTC, YYYY-MM-DD+1 03:00 UTC).
const ARGENTINA_UTC_OFFSET_MS = 3 * 60 * 60 * 1000; // UTC-3 in ms

const ARGENTINA_DATE_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: ARGENTINA_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/**
 * Returns the Argentina calendar date string "YYYY-MM-DD" for the given UTC
 * epoch milliseconds (defaults to Date.now()).
 *
 * Uses Intl.DateTimeFormat — no manual offset arithmetic.
 */
export function getArgentinaDateString(ms: number = Date.now()): string {
  return ARGENTINA_DATE_FORMATTER.format(new Date(ms));
}

/**
 * Returns the UTC epoch (ms) of midnight ART for the calendar day that
 * contains `ms`. ART midnight = YYYY-MM-DD 03:00 UTC (UTC-3).
 *
 * Identical behavior to the manual `ART_OFFSET_MS` arithmetic previously
 * duplicated across ai-rate-limit, owner-chat-quota, employee-handler, etc.
 */
export function getArgentinaDayStart(ms: number = Date.now()): number {
  const dateAR = getArgentinaDateString(ms);
  const [year, month, day] = dateAR.split("-").map((p) => Number(p));
  // Date.UTC gives "YYYY-MM-DD 00:00 UTC"; ART midnight is 3 h later in UTC.
  return Date.UTC(year, month - 1, day) + ARGENTINA_UTC_OFFSET_MS;
}

/**
 * Returns the [startMs, endMs] window of the Argentina calendar day that
 * contains `ms`. endMs is the last representable millisecond of that day.
 *
 * Re-exported from today-summary.ts so dashboard code can use either import
 * path during the migration period.
 */
export function getArgentinaDayBounds(
  ms: number = Date.now(),
): { startMs: number; endMs: number; dateAR: string } {
  const dateAR = getArgentinaDateString(ms);
  const startMs = getArgentinaDayStart(ms);
  const endMs = startMs + 24 * 60 * 60 * 1000 - 1;
  return { startMs, endMs, dateAR };
}
