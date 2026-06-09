/**
 * Behavior-equivalence proof: cron-parser vs the hand-rolled matcher.
 *
 * For every (cronExpr, slotKey) pair below, the new cron-parser-backed
 * `matchesCronExpressionWithParser` MUST return the SAME boolean as
 * the documented old behavior (captured as `expected`).
 *
 * If ANY row diverges this test fails, which is the gate before shipping.
 */
import { describe, it, expect } from "vitest";
import { matchesCronExpressionWithParser } from "@/app/api/scheduled/rule-alerts/_lib/cron-matcher";

// 2024-01-14 = Sunday (dow=0), 2024-01-15 = Monday (dow=1)
const cases: Array<{
  cron: string;
  slotKey: string;
  expected: boolean;
  desc: string;
}> = [
  // ── literal minute ────────────────────────────────────────────────────────
  { cron: "30 9 * * *", slotKey: "2024-01-15T09:30", expected: true,  desc: "literal 30: matches exact slot" },
  { cron: "30 9 * * *", slotKey: "2024-01-15T09:35", expected: false, desc: "literal 30: outside window (slot 35)" },
  { cron: "30 9 * * *", slotKey: "2024-01-15T09:25", expected: false, desc: "literal 30: outside window (slot 25)" },

  // ── wildcard minute ───────────────────────────────────────────────────────
  { cron: "* * * * *",  slotKey: "2024-01-15T09:33", expected: true,  desc: "wildcard: always matches" },
  { cron: "* * * * *",  slotKey: "2024-01-15T00:00", expected: true,  desc: "wildcard: matches midnight" },

  // ── step expressions ──────────────────────────────────────────────────────
  { cron: "*/15 * * * *", slotKey: "2024-01-15T09:00", expected: true,  desc: "*/15: fires at slot 0" },
  { cron: "*/15 * * * *", slotKey: "2024-01-15T09:15", expected: true,  desc: "*/15: fires at slot 15" },
  { cron: "*/15 * * * *", slotKey: "2024-01-15T09:30", expected: true,  desc: "*/15: fires at slot 30" },
  { cron: "*/15 * * * *", slotKey: "2024-01-15T09:45", expected: true,  desc: "*/15: fires at slot 45" },
  { cron: "*/15 * * * *", slotKey: "2024-01-15T09:10", expected: false, desc: "*/15: does NOT fire at slot 10" },
  { cron: "*/5 * * * *",  slotKey: "2024-01-15T09:00", expected: true,  desc: "*/5: fires at slot 0" },
  { cron: "*/5 * * * *",  slotKey: "2024-01-15T09:05", expected: true,  desc: "*/5: fires at slot 5" },
  { cron: "*/5 * * * *",  slotKey: "2024-01-15T09:55", expected: true,  desc: "*/5: fires at slot 55" },
  { cron: "*/5 * * * *",  slotKey: "2024-01-15T09:10", expected: true,  desc: "*/5: fires at slot 10" },

  // ── range expressions ─────────────────────────────────────────────────────
  { cron: "5-10 9 * * *", slotKey: "2024-01-15T09:05", expected: true,  desc: "range 5-10: fires at slot 5" },
  { cron: "5-10 9 * * *", slotKey: "2024-01-15T09:10", expected: true,  desc: "range 5-10: fires at slot 10" },
  { cron: "5-10 9 * * *", slotKey: "2024-01-15T09:00", expected: false, desc: "range 5-10: NOT at slot 0" },
  { cron: "5-10 9 * * *", slotKey: "2024-01-15T09:15", expected: false, desc: "range 5-10: NOT at slot 15" },

  // ── list expressions ──────────────────────────────────────────────────────
  { cron: "0,30 9 * * *",    slotKey: "2024-01-15T09:00", expected: true,  desc: "list 0,30: fires at slot 0" },
  { cron: "0,30 9 * * *",    slotKey: "2024-01-15T09:30", expected: true,  desc: "list 0,30: fires at slot 30" },
  { cron: "0,30 9 * * *",    slotKey: "2024-01-15T09:15", expected: false, desc: "list 0,30: NOT at slot 15" },
  { cron: "0,30 8-18 * * *", slotKey: "2024-01-15T08:00", expected: true,  desc: "list+hour-range: fires at 8:00" },
  { cron: "0,30 8-18 * * *", slotKey: "2024-01-15T18:30", expected: true,  desc: "list+hour-range: fires at 18:30" },
  { cron: "0,30 8-18 * * *", slotKey: "2024-01-15T19:00", expected: false, desc: "list+hour-range: NOT at 19:00" },

  // ── hour field ────────────────────────────────────────────────────────────
  { cron: "0 9 * * *",  slotKey: "2024-01-15T10:00", expected: false, desc: "wrong hour does not fire" },
  { cron: "0 * * * *",  slotKey: "2024-01-15T22:00", expected: true,  desc: "hour wildcard fires any hour" },
  { cron: "0 */2 * * *", slotKey: "2024-01-15T00:00", expected: true,  desc: "hour */2: fires at 0" },
  { cron: "0 */2 * * *", slotKey: "2024-01-15T02:00", expected: true,  desc: "hour */2: fires at 2" },
  { cron: "0 */2 * * *", slotKey: "2024-01-15T01:00", expected: false, desc: "hour */2: NOT at 1" },

  // ── midnight ──────────────────────────────────────────────────────────────
  { cron: "0 0 * * *", slotKey: "2024-01-15T00:00", expected: true,  desc: "midnight: matches 00:00 slot" },
  { cron: "0 0 * * *", slotKey: "2024-01-15T00:05", expected: false, desc: "midnight: NOT at 00:05 slot" },

  // ── day-of-week ───────────────────────────────────────────────────────────
  { cron: "0 9 * * 0",   slotKey: "2024-01-14T09:00", expected: true,  desc: "dow=0 (Sunday): fires on Sunday" },
  { cron: "0 9 * * 0",   slotKey: "2024-01-15T09:00", expected: false, desc: "dow=0 (Sunday): NOT on Monday" },
  { cron: "30 9 * * 1-5", slotKey: "2024-01-15T09:30", expected: true,  desc: "dow 1-5: fires on Monday" },
  { cron: "30 9 * * 1-5", slotKey: "2024-01-14T09:30", expected: false, desc: "dow 1-5: NOT on Sunday" },

  // ── DOM/month rejection (contract preserved) ──────────────────────────────
  { cron: "0 9 1 * *",  slotKey: "2024-01-15T09:00", expected: false, desc: "DOM=1: rejected" },
  { cron: "0 9 * 12 *", slotKey: "2024-01-15T09:00", expected: false, desc: "month=12: rejected" },
  { cron: "0 9 1 1 *",  slotKey: "2024-01-15T09:00", expected: false, desc: "DOM+month: rejected" },

  // ── malformed inputs ──────────────────────────────────────────────────────
  { cron: "* * * *",    slotKey: "2024-01-15T09:00", expected: false, desc: "too few fields" },
  { cron: "",           slotKey: "2024-01-15T09:00", expected: false, desc: "empty string" },
];

describe("matchesCronExpressionWithParser — behavior equivalence vs hand-rolled matcher", () => {
  it.each(cases)("$desc", ({ cron, slotKey, expected }) => {
    expect(matchesCronExpressionWithParser(cron, slotKey)).toBe(expected);
  });
});
