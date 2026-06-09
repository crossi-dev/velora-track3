const assert = require("node:assert/strict");
const test = require("node:test");

const {
  detectBulkPriceUpdate,
} = require("../../src/app/dashboard/lib/command-parsers/bulk-price-update.ts");

const {
  validateParsedAction,
} = require("../../src/app/api/business-assistant/_lib/validate-action.ts");

// ── parser: set direction ───────────────────────────────────────────

test("'pone todos los precios a $50' → set + absolute", () => {
  const r = detectBulkPriceUpdate("pone todos los precios a 50");
  assert.ok(r);
  assert.equal(r.intent, "bulk_price_update");
  assert.equal(r.data.direction, "set");
  assert.equal(r.data.mode, "absolute");
  assert.equal(r.data.amount, 50);
});

test("'poné todos los precios en 100' → set", () => {
  const r = detectBulkPriceUpdate("pone todos los precios en 100");
  assert.ok(r);
  assert.equal(r.data.direction, "set");
});

test("'fijá precios a 200' → set", () => {
  const r = detectBulkPriceUpdate("fija todos los precios a 200");
  assert.ok(r);
  assert.equal(r.data.direction, "set");
});

test("'dejá todos a 75' → set", () => {
  const r = detectBulkPriceUpdate("deja todos a 75");
  assert.ok(r);
  assert.equal(r.data.direction, "set");
});

test("set verb without amount falls through (no match)", () => {
  const r = detectBulkPriceUpdate("pone todos los precios");
  assert.equal(r, null);
});

test("set verb with percentage returns null (set+% explicitly rejected)", () => {
  // 2026-05: "pone todos al 50%" is now rejected entirely (returns null).
  // "set" + "%" is a dangerous combination — "set all prices to 50%" could be
  // misread as "multiply all by 0.50". The parser explicitly rejects percent
  // when direction is "set" to prevent bulk-overwriting every price by accident.
  // Previously it fell through to the absolute branch and matched "50" as $50;
  // that silent fallback was removed as a safety improvement.
  const r = detectBulkPriceUpdate("pone todos al 50%");
  assert.equal(r, null,
    "set + percentage should be rejected, not silently treated as absolute");
});

// ── parser: existing behavior preserved ─────────────────────────────

test("'subi 10% a todos' still matches up + percentage", () => {
  const r = detectBulkPriceUpdate("subi 10% a todos");
  assert.ok(r);
  assert.equal(r.data.direction, "up");
  assert.equal(r.data.mode, "percentage");
});

test("'baja 200 pesos a todos' still matches down + absolute", () => {
  const r = detectBulkPriceUpdate("baja 200 pesos a todos");
  assert.ok(r);
  assert.equal(r.data.direction, "down");
  assert.equal(r.data.mode, "absolute");
});

// ── validator: set + absolute passes ────────────────────────────────

test("validator accepts bulk_price_update with set + absolute", () => {
  const r = validateParsedAction("bulk_price_update", {
    bulkPriceUpdate: { amount: 50, mode: "absolute", direction: "set", target: "all" },
  });
  assert.equal(r.valid, true);
});
