// Natural-language relative date parser for Argentine Spanish.
//
// Uses chrono-node (MIT, ~120 kB) for the heavy lifting and adds targeted
// pre-processing for expressions chrono-node ES does not cover natively:
//   "anteayer", "antier", "hace N días", "la semana pasada", "el mes pasado"
//
// All boundaries are normalised to full calendar-day ranges in the
// America/Argentina/Buenos_Aires timezone (UTC-3, no DST).
//
// Exported for use by command parsers and unit tests.

import * as chrono from "chrono-node";
import { getArgentinaDayBounds, getArgentinaDateString } from "../app/dashboard/lib/today-summary";

// ── Public types ──────────────────────────────────────────────────────────────

export type RelativeDateLabel =
  | "today"
  | "yesterday"
  | "day_before_yesterday"
  | "this_week"
  | "this_month"
  | "last_week"
  | "last_month"
  | "named_day"
  | "specific_date";

export interface ParsedDateRange {
  /** Start of the day / period in milliseconds (inclusive, AR midnight). */
  startMs: number;
  /** End of the day / period in milliseconds (inclusive, 23:59:59.999 AR). */
  endMs: number;
  /** Semantic label describing which bucket was matched. */
  label: RelativeDateLabel;
}

// ── Internal constants ────────────────────────────────────────────────────────

const ARGENTINA_UTC_OFFSET_MS = 3 * 60 * 60 * 1000; // UTC-3, fixed (no DST)

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Returns the start (AR midnight in UTC ms) and end (23:59:59.999 in UTC ms)
 * of the calendar day that is `daysBack` days before `now`.
 */
function dayBoundsOffset(now: Date, daysBack: number): { startMs: number; endMs: number } {
  const pivotMs = now.getTime() - daysBack * 24 * 60 * 60 * 1000;
  return getArgentinaDayBounds(pivotMs);
}

/**
 * Given a Date produced by chrono (which is in local/UTC), snap it to the
 * AR calendar day it falls in and return full-day bounds (00:00→23:59:59.999).
 */
function chronoDateToDayBounds(d: Date): { startMs: number; endMs: number } {
  return getArgentinaDayBounds(d.getTime());
}

/**
 * Returns the Monday-to-Sunday bounds for the ISO week containing `pivotMs`.
 * "Monday" is the first day of the week.
 */
function weekBoundsContaining(pivotMs: number): { startMs: number; endMs: number } {
  let cursor = pivotMs;
  // Walk backward until we land on Monday (getDay() === 1).
  while (true) {
    const dateStr = getArgentinaDateString(cursor); // "YYYY-MM-DD"
    const jsDay = new Date(dateStr + "T00:00:00Z").getUTCDay(); // 0=Sun
    if (jsDay === 1) break;
    const { startMs } = getArgentinaDayBounds(cursor);
    cursor = startMs - 1; // jump to previous AR day
  }
  const { startMs: weekStart } = getArgentinaDayBounds(cursor);
  // Sunday = Monday + 6 days; its endMs is 23:59:59.999 of that day.
  const sundayMs = weekStart + 6 * 24 * 60 * 60 * 1000;
  const { endMs: weekEnd } = getArgentinaDayBounds(sundayMs);
  return { startMs: weekStart, endMs: weekEnd };
}

/**
 * Returns the first-of-month to last-of-month bounds for the AR month
 * containing `pivotMs`.
 */
function monthBoundsContaining(pivotMs: number): { startMs: number; endMs: number } {
  const dateStr = getArgentinaDateString(pivotMs); // "YYYY-MM-DD"
  const [year, month] = dateStr.split("-").map(Number);
  const startMs = Date.UTC(year, month - 1, 1) + ARGENTINA_UTC_OFFSET_MS;
  // Last day of month = day 0 of the NEXT month.
  const lastDayMs = Date.UTC(year, month, 0) + ARGENTINA_UTC_OFFSET_MS;
  const { endMs } = getArgentinaDayBounds(lastDayMs);
  return { startMs, endMs };
}

// ── Pre-processing patterns (gaps in chrono-node ES) ─────────────────────────

/** "anteayer" / "antier" → 2 days ago */
const ANTEAYER_RE = /\b(?:antes?\s+de\s+ayer|anteayer|antier)\b/i;

/** "hace N días/semanas/meses" → offset from now */
const HACE_N_RE = /\bhace\s+(\d+|un?a?|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)\s+(d[ií]as?|semanas?|meses?)\b/i;

const WORD_TO_NUM: Record<string, number> = {
  un: 1, una: 1, uno: 1,
  dos: 2, tres: 3, cuatro: 4, cinco: 5,
  seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10,
};

function resolveWordNum(token: string): number {
  if (/^\d+$/.test(token)) return Number(token);
  return WORD_TO_NUM[token.toLowerCase()] ?? 1;
}

/** "la semana pasada" / "semana anterior" / "la última semana" */
const SEMANA_PASADA_RE = /\b(?:la\s+)?(?:semana\s+pasada|semana\s+anterior|[uú]ltima\s+semana)\b/i;

/** "el mes pasado" / "mes anterior" */
const MES_PASADO_RE = /\b(?:el\s+)?(?:mes\s+pasado|mes\s+anterior)\b/i;

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Parses a natural-language date expression in Argentine Spanish and returns
 * a `ParsedDateRange` with full-day boundaries in AR time, or `null` if no
 * date-like expression is detected.
 *
 * @param text    Normalised input text (lowercase, no accents required).
 * @param now     Reference point for relative expressions. Defaults to Date.now().
 */
export function parseRelativeDateAR(
  text: string,
  now: Date = new Date(),
): ParsedDateRange | null {
  // ── 1. Pre-defined fast literals ──────────────────────────────────────────
  if (/\bhoy\b/.test(text)) {
    const { startMs, endMs } = getArgentinaDayBounds(now.getTime());
    return { startMs, endMs: Math.min(endMs, now.getTime()), label: "today" };
  }

  if (/\bayer\b/.test(text)) {
    const { startMs: todayStart } = getArgentinaDayBounds(now.getTime());
    const { startMs, endMs } = getArgentinaDayBounds(todayStart - 1);
    return { startMs, endMs, label: "yesterday" };
  }

  if (ANTEAYER_RE.test(text)) {
    const { startMs, endMs } = dayBoundsOffset(now, 2);
    return { startMs, endMs, label: "day_before_yesterday" };
  }

  // ── 2. "esta semana" / "esta semana" ─────────────────────────────────────
  if (/\b(?:esta\s+semana|semanal)\b/.test(text)) {
    const { startMs } = weekBoundsContaining(now.getTime());
    return { startMs, endMs: now.getTime(), label: "this_week" };
  }

  if (SEMANA_PASADA_RE.test(text)) {
    // Previous week: go back 7 days to land inside it, then get full week bounds.
    const lastWeekPivot = now.getTime() - 7 * 24 * 60 * 60 * 1000;
    const { startMs, endMs } = weekBoundsContaining(lastWeekPivot);
    return { startMs, endMs, label: "last_week" };
  }

  // ── 3. "este mes" ─────────────────────────────────────────────────────────
  if (/\b(?:este\s+mes|mensual)\b/.test(text)) {
    const { startMs } = monthBoundsContaining(now.getTime());
    return { startMs, endMs: now.getTime(), label: "this_month" };
  }

  if (MES_PASADO_RE.test(text)) {
    // Last month: go back 32 days to land safely in the previous month.
    const lastMonthPivot = now.getTime() - 32 * 24 * 60 * 60 * 1000;
    const { startMs, endMs } = monthBoundsContaining(lastMonthPivot);
    return { startMs, endMs, label: "last_month" };
  }

  // ── 4. "hace N días / semanas / meses" ───────────────────────────────────
  const haceMatch = text.match(HACE_N_RE);
  if (haceMatch) {
    const n = resolveWordNum(haceMatch[1]);
    const unit = haceMatch[2].toLowerCase();

    if (unit.startsWith("d")) {
      // "hace 3 días" → that specific day
      const { startMs, endMs } = dayBoundsOffset(now, n);
      return { startMs, endMs, label: "specific_date" };
    }
    if (unit.startsWith("s")) {
      // "hace 2 semanas" → that week range
      const pivot = now.getTime() - n * 7 * 24 * 60 * 60 * 1000;
      const { startMs, endMs } = weekBoundsContaining(pivot);
      return { startMs, endMs, label: "last_week" };
    }
    if (unit.startsWith("m")) {
      // "hace 2 meses" → that month range (use 32*n days as safe pivot)
      const pivot = now.getTime() - n * 32 * 24 * 60 * 60 * 1000;
      const { startMs, endMs } = monthBoundsContaining(pivot);
      return { startMs, endMs, label: "last_month" };
    }
  }

  // ── 5. chrono-node ES for everything else ─────────────────────────────────
  // Use forwardDate: false so bare weekday names ("el martes") resolve to the
  // most-recent past occurrence, matching user intent for sales queries.
  // Expressions with "próximo" / "siguiente" are forwarded by chrono internally.
  const results = chrono.es.parse(text, now, { forwardDate: false });
  if (results.length === 0) return null;

  const first = results[0];
  const startDate = first.start.date();

  // If chrono found an end component (range expression), use it.
  const endDate = first.end?.date() ?? null;

  if (endDate) {
    const { startMs } = chronoDateToDayBounds(startDate);
    const { endMs } = chronoDateToDayBounds(endDate);
    return { startMs, endMs, label: "specific_date" };
  }

  const { startMs, endMs } = chronoDateToDayBounds(startDate);
  return { startMs, endMs, label: "named_day" };
}
