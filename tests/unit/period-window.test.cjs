const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildPeriodWindow,
} = require("../../src/app/dashboard/lib/period-window.ts");

// Tests use relative comparisons (start < end, start at midnight, etc.) so
// they don't depend on the test wall-clock. The `now` reference inside
// buildPeriodWindow is captured once per call.

test("buildPeriodWindow('today'): start at local midnight, end is 'now', labels are 'Hoy'", () => {
  const before = Date.now();
  const w = buildPeriodWindow("today");
  const after = Date.now();

  assert.equal(w.label, "Hoy");
  assert.equal(w.emptyLabel, "Hoy");

  // endMs is captured during the call → must be within the [before, after] bracket
  assert.ok(w.endMs >= before && w.endMs <= after, "endMs should reflect call time");

  // startMs must be at midnight: a Date constructed from it has 0 hours/min/sec
  const start = new Date(w.startMs);
  assert.equal(start.getHours(), 0);
  assert.equal(start.getMinutes(), 0);
  assert.equal(start.getSeconds(), 0);
  assert.equal(start.getMilliseconds(), 0);

  // Start must be the SAME calendar day as `now`
  const now = new Date(w.endMs);
  assert.equal(start.getFullYear(), now.getFullYear());
  assert.equal(start.getMonth(), now.getMonth());
  assert.equal(start.getDate(), now.getDate());

  // Start always precedes or equals end
  assert.ok(w.startMs <= w.endMs);
});

test("buildPeriodWindow('yesterday'): start = today's midnight - 24h, end = 1ms before today's midnight", () => {
  const w = buildPeriodWindow("yesterday");
  assert.equal(w.label, "Ayer");

  const start = new Date(w.startMs);
  const end = new Date(w.endMs);

  // Start must be at midnight
  assert.equal(start.getHours(), 0);
  assert.equal(start.getMinutes(), 0);
  assert.equal(start.getSeconds(), 0);

  // End must be 23:59:59.999 of yesterday — i.e. one millisecond before
  // today's midnight. Verify by reconstructing today's midnight and subtracting 1.
  const todayMidnight = new Date(end.getFullYear(), end.getMonth(), end.getDate() + 1).getTime();
  assert.equal(w.endMs, todayMidnight - 1, "endMs must be 1ms before today's midnight");

  // The window spans exactly one day (with millisecond precision) — so
  // start + 24h - 1ms should equal end (give or take DST shifts; on a
  // normal day the diff is exactly 86400000 - 1).
  const oneDayMinusMs = 24 * 60 * 60 * 1000 - 1;
  assert.equal(w.endMs - w.startMs, oneDayMinusMs);
});

test("buildPeriodWindow('week'): start at Monday's midnight, end at 'now', label 'Esta semana'", () => {
  const w = buildPeriodWindow("week");
  assert.equal(w.label, "Esta semana");

  const start = new Date(w.startMs);
  // Monday in JS getDay() is 1; the helper shifts so Monday is day 0 of the week.
  // Start must be Monday → getDay() === 1.
  assert.equal(start.getDay(), 1, "week start should fall on a Monday");
  assert.equal(start.getHours(), 0);
  assert.equal(start.getMinutes(), 0);

  // Start must be on or before today
  assert.ok(w.startMs <= w.endMs);

  // The diff between start and now should be at most 6 days + ~1 day worth of seconds
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
  assert.ok(w.endMs - w.startMs < sevenDaysMs, "week window cannot exceed 7 days");
});

test("buildPeriodWindow('month'): start on day 1 at midnight, end at 'now', label 'Este mes'", () => {
  const w = buildPeriodWindow("month");
  assert.equal(w.label, "Este mes");

  const start = new Date(w.startMs);
  const end = new Date(w.endMs);

  // Start must be day 1 of the same month as `now`
  assert.equal(start.getDate(), 1);
  assert.equal(start.getHours(), 0);
  assert.equal(start.getMonth(), end.getMonth());
  assert.equal(start.getFullYear(), end.getFullYear());

  // Start <= end
  assert.ok(w.startMs <= w.endMs);
});

test("buildPeriodWindow: start is always strictly less than or equal to end", () => {
  for (const period of ["today", "yesterday", "week", "month"]) {
    const w = buildPeriodWindow(period);
    assert.ok(w.startMs <= w.endMs, `${period}: startMs ${w.startMs} must be <= endMs ${w.endMs}`);
  }
});
