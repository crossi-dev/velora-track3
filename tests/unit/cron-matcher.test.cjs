const assert = require("node:assert/strict");
const test = require("node:test");

const {
  matchesCronExpression,
  slotFromInstant,
  SLOT_MINUTES,
} = require("../../src/app/api/scheduled/rule-alerts/_lib/cron-matcher.ts");

// ── helpers ─────────────────────────────────────────────────────────────────

// Build a SlotInstant directly (avoids timezone gymnastics in test env)
function slot(hourART, minuteART, dowART = 1) {
  return { slotKey: "test", hourART, minuteART, dowART };
}

// ── basic fixed-minute match ─────────────────────────────────────────────────

test("literal minute matches within the 5-min window", () => {
  // Rule "30 9 * * *" should fire for slot at 09:30 ART
  assert.equal(matchesCronExpression("30 9 * * *", slot(9, 30)), true);
});

test("literal minute at start of window", () => {
  assert.equal(matchesCronExpression("30 9 * * *", slot(9, 30)), true);
});

test("literal minute outside window does not match", () => {
  // slot minute = 35 means window is 35-39; minute 30 is outside
  assert.equal(matchesCronExpression("30 9 * * *", slot(9, 35)), false);
});

test("wildcard minute always matches", () => {
  assert.equal(matchesCronExpression("* * * * *", slot(9, 33)), true);
});

// ── step expressions (the bug that was fixed) ────────────────────────────────

test("*/15 minute step fires at minute 0", () => {
  assert.equal(matchesCronExpression("*/15 * * * *", slot(9, 0)), true);
});

test("*/15 minute step fires at minute 15", () => {
  assert.equal(matchesCronExpression("*/15 * * * *", slot(9, 15)), true);
});

test("*/15 minute step fires at minute 30", () => {
  assert.equal(matchesCronExpression("*/15 * * * *", slot(9, 30)), true);
});

test("*/15 minute step fires at minute 45", () => {
  assert.equal(matchesCronExpression("*/15 * * * *", slot(9, 45)), true);
});

test("*/15 minute step does NOT fire at minute 10", () => {
  assert.equal(matchesCronExpression("*/15 * * * *", slot(9, 10)), false);
});

test("*/5 minute step fires every slot", () => {
  // Every slot is a multiple of 5 (slotFromInstant floors to nearest 5)
  for (const m of [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]) {
    assert.equal(matchesCronExpression("*/5 * * * *", slot(9, m)), true, `failed at minute ${m}`);
  }
});

// ── range expressions ────────────────────────────────────────────────────────

test("range 5-10 minute fires at minute 5", () => {
  assert.equal(matchesCronExpression("5-10 9 * * *", slot(9, 5)), true);
});

test("range 5-10 minute fires at minute 10", () => {
  assert.equal(matchesCronExpression("5-10 9 * * *", slot(9, 10)), true);
});

test("range 5-10 minute does NOT fire at minute 0", () => {
  assert.equal(matchesCronExpression("5-10 9 * * *", slot(9, 0)), false);
});

// ── list expressions ─────────────────────────────────────────────────────────

test("list 0,30 fires at minute 0", () => {
  assert.equal(matchesCronExpression("0,30 9 * * *", slot(9, 0)), true);
});

test("list 0,30 fires at minute 30", () => {
  assert.equal(matchesCronExpression("0,30 9 * * *", slot(9, 30)), true);
});

test("list 0,30 does NOT fire at minute 15", () => {
  assert.equal(matchesCronExpression("0,30 9 * * *", slot(9, 15)), false);
});

// ── hour field ───────────────────────────────────────────────────────────────

test("wrong hour does not fire", () => {
  assert.equal(matchesCronExpression("0 9 * * *", slot(10, 0)), false);
});

test("hour wildcard fires any hour", () => {
  assert.equal(matchesCronExpression("0 * * * *", slot(22, 0)), true);
});

test("hour step */2 fires at even hours", () => {
  assert.equal(matchesCronExpression("0 */2 * * *", slot(0, 0)), true);
  assert.equal(matchesCronExpression("0 */2 * * *", slot(2, 0)), true);
  assert.equal(matchesCronExpression("0 */2 * * *", slot(1, 0)), false);
});

// ── day-of-week field ─────────────────────────────────────────────────────────

test("dow=0 (Sunday) fires only on Sunday", () => {
  assert.equal(matchesCronExpression("0 9 * * 0", slot(9, 0, 0)), true);
  assert.equal(matchesCronExpression("0 9 * * 0", slot(9, 0, 1)), false);
});

// ── DOM/month non-wildcard rejection (Fix 2) ─────────────────────────────────

test("non-wildcard day-of-month returns false (reject, not ignore)", () => {
  // "0 9 1 * *" should NOT silently fire on every day — it must return false
  assert.equal(matchesCronExpression("0 9 1 * *", slot(9, 0)), false);
});

test("non-wildcard month returns false", () => {
  assert.equal(matchesCronExpression("0 9 * 12 *", slot(9, 0)), false);
});

test("both DOM and month non-wildcard returns false", () => {
  assert.equal(matchesCronExpression("0 9 1 1 *", slot(9, 0)), false);
});

// ── edge cases ───────────────────────────────────────────────────────────────

test("too few fields returns false", () => {
  assert.equal(matchesCronExpression("* * * *", slot(9, 0)), false);
});

test("empty string returns false", () => {
  assert.equal(matchesCronExpression("", slot(9, 0)), false);
});
