// Computes start/end millisecond timestamps for common dashboard period keys.
// All boundaries are computed in the America/Argentina/Buenos_Aires timezone
// (UTC-3, no DST) so they are correct on Cloud Run (which runs in UTC).

import { getArgentinaDayBounds, getArgentinaDateString } from "./today-summary";

export interface PeriodWindow {
  startMs: number;
  endMs: number;
  label: string;
  emptyLabel: string;
}

function todayWindow(now: number): PeriodWindow {
  const { startMs } = getArgentinaDayBounds(now);
  return { startMs, endMs: now, label: "Hoy", emptyLabel: "Hoy" };
}

function yesterdayWindow(now: number): PeriodWindow {
  const { startMs: todayStart } = getArgentinaDayBounds(now);
  // Yesterday = the AR day that ends 1ms before today's AR midnight.
  const { startMs, endMs } = getArgentinaDayBounds(todayStart - 1);
  return { startMs, endMs, label: "Ayer", emptyLabel: "Ayer" };
}

function weekWindow(now: number): PeriodWindow {
  // Find Monday of the current Argentina week. Step back day-by-day using
  // AR date strings so DST (even if it ever returns) can't shift us.
  let cursor = now;
  while (true) {
    const dateStr = getArgentinaDateString(cursor); // "YYYY-MM-DD"
    const jsDay = new Date(dateStr + "T00:00:00Z").getUTCDay(); // 0=Sun, 1=Mon
    if (jsDay === 1) break; // Monday
    const { startMs } = getArgentinaDayBounds(cursor);
    cursor = startMs - 1; // jump to the previous AR day
  }
  const { startMs } = getArgentinaDayBounds(cursor);
  return { startMs, endMs: now, label: "Esta semana", emptyLabel: "Esta semana" };
}

function monthWindow(now: number): PeriodWindow {
  const dateStr = getArgentinaDateString(now); // "YYYY-MM-DD"
  const [year, month] = dateStr.split("-").map(Number);
  // First day of the current AR month at AR midnight (UTC-3 → +3h in UTC).
  const AR_OFFSET_MS = 3 * 60 * 60 * 1000;
  const startMs = Date.UTC(year, month - 1, 1) + AR_OFFSET_MS;
  return { startMs, endMs: now, label: "Este mes", emptyLabel: "Este mes" };
}

export function buildPeriodWindow(
  period: "today" | "yesterday" | "week" | "month"
): PeriodWindow {
  const now = Date.now();
  switch (period) {
    case "today":     return todayWindow(now);
    case "yesterday": return yesterdayWindow(now);
    case "week":      return weekWindow(now);
    case "month":     return monthWindow(now);
  }
}
