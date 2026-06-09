/**
 * Parity tests for src/lib/argentina-date.ts (SLICE 5 — Unit A)
 *
 * Verifies that the Intl-based helpers produce the SAME results as the manual
 * UTC-3 arithmetic they replaced across ai-rate-limit, owner-chat-quota,
 * employee-handler.stages-daily-welcome, owner-handler.stages-daily-nudge,
 * and promesa-vencida-cron.
 */

import { describe, it, expect } from "vitest";
import {
  getArgentinaDateString,
  getArgentinaDayStart,
  getArgentinaDayBounds,
} from "@/lib/argentina-date";

// ── helpers that mirror the OLD manual arithmetic exactly ─────────────────────

const OLD_OFFSET_MS = 3 * 3600_000; // UTC-3, no DST

/** Old ai-rate-limit.ts: getArtDayStart() */
function oldArtDayStart(nowMs: number): Date {
  const arNow = new Date(nowMs - OLD_OFFSET_MS);
  arNow.setUTCHours(0, 0, 0, 0);
  return new Date(arNow.getTime() + OLD_OFFSET_MS);
}

/** Old owner-chat-quota.ts: artDateString() */
function oldArtDateString(nowMs: number): string {
  const artMs = nowMs - OLD_OFFSET_MS; // note: ART_OFFSET_HOURS = -3 → +(-3)*3600000
  return new Date(artMs).toISOString().slice(0, 10);
}

/** Old promesa-vencida-cron.ts: artDateSlot() */
function oldArtDateSlot(nowMs: number): string {
  const artMs = nowMs - OLD_OFFSET_MS;
  const d = new Date(artMs);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}${mm}${dd}`;
}

/** Old artDateParts (employee/owner-handler): dayStart reconstruction */
function oldArtDayStartFromDateStr(nowMs: number): Date {
  const artMs = nowMs - OLD_OFFSET_MS;
  const dateStr = new Date(artMs).toISOString().slice(0, 10);
  return new Date(`${dateStr}T03:00:00Z`);
}

// ── test timestamps ────────────────────────────────────────────────────────────
// Pick moments that straddle ART midnight (03:00 UTC = 00:00 ART)
// to catch any off-by-one at boundary.

const CASES = [
  // ART noon — well inside a day
  { label: "2026-06-07 noon ART", ms: Date.UTC(2026, 5, 7, 15, 0, 0) },
  // ART midnight (= 03:00 UTC next) — straddles the UTC/ART boundary
  { label: "2026-06-07 just before ART midnight (02:59 UTC)", ms: Date.UTC(2026, 5, 7, 2, 59, 59, 999) },
  { label: "2026-06-07 ART midnight exactly (03:00 UTC)", ms: Date.UTC(2026, 5, 7, 3, 0, 0, 0) },
  // DST would have mattered here historically — confirm it doesn't
  { label: "2024-10-20 DST-adjacent (no DST in AR since 2009)", ms: Date.UTC(2024, 9, 20, 12, 0, 0) },
  // New Year boundary
  { label: "2026-01-01 ART (2026-01-01 03:00 UTC)", ms: Date.UTC(2026, 0, 1, 3, 0, 0) },
  // Before midnight in ART (still previous UTC day)
  { label: "2026-03-15 01:00 UTC = 2026-03-14 22:00 ART", ms: Date.UTC(2026, 2, 15, 1, 0, 0) },
];

describe("getArgentinaDateString", () => {
  for (const { label, ms } of CASES) {
    it(`matches old manual arithmetic — ${label}`, () => {
      expect(getArgentinaDateString(ms)).toBe(oldArtDateString(ms));
    });
  }
});

describe("getArgentinaDayStart", () => {
  for (const { label, ms } of CASES) {
    it(`matches old ai-rate-limit.getArtDayStart — ${label}`, () => {
      expect(getArgentinaDayStart(ms)).toBe(oldArtDayStart(ms).getTime());
    });
  }

  for (const { label, ms } of CASES) {
    it(`matches old artDateParts dayStart — ${label}`, () => {
      expect(getArgentinaDayStart(ms)).toBe(oldArtDayStartFromDateStr(ms).getTime());
    });
  }
});

describe("artDateSlot (YYYYMMDD)", () => {
  for (const { label, ms } of CASES) {
    it(`matches old promesa-vencida artDateSlot — ${label}`, () => {
      const newSlot = getArgentinaDateString(ms).replace(/-/g, "");
      expect(newSlot).toBe(oldArtDateSlot(ms));
    });
  }
});

describe("getArgentinaDayBounds", () => {
  it("startMs + 24h - 1ms = endMs", () => {
    const ms = Date.UTC(2026, 5, 7, 12, 0, 0);
    const { startMs, endMs } = getArgentinaDayBounds(ms);
    expect(endMs - startMs).toBe(24 * 60 * 60 * 1000 - 1);
  });

  it("startMs is 03:00 UTC for an ART day", () => {
    // ART day 2026-06-07 starts at 2026-06-07T03:00:00Z
    const ms = Date.UTC(2026, 5, 7, 12, 0, 0);
    const { startMs, dateAR } = getArgentinaDayBounds(ms);
    expect(dateAR).toBe("2026-06-07");
    expect(new Date(startMs).toISOString()).toBe("2026-06-07T03:00:00.000Z");
  });
});
