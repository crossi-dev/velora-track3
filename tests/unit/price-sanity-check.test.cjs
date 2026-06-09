const assert = require("node:assert/strict");
const test = require("node:test");

const {
  detectPriceOutlier,
} = require("../../src/domain/rules/index.ts");

const {
  buildPriceOutlierLabel,
} = require("../../src/app/dashboard/lib/price-outlier-label.ts");

// PRICE_OUTLIER_THRESHOLD was exported from the old wrapper at 0.5.
// The domain default is also 0.5 — kept here as a literal for the constant test.
const PRICE_OUTLIER_THRESHOLD = 0.5;

// ── Constants ──────────────────────────────────────────────────────

test("PRICE_OUTLIER_THRESHOLD is 0.5 (±50% per spec)", () => {
  assert.equal(PRICE_OUTLIER_THRESHOLD, 0.5);
});

// ── detectPriceOutlier ─────────────────────────────────────────────

test("entered equals expected → null (no deviation)", () => {
  assert.equal(detectPriceOutlier(1000, 1000, PRICE_OUTLIER_THRESHOLD), null);
});

test("entered 50% above expected (edge, inclusive) → null", () => {
  // 1000 → 1500 is exactly at the threshold → not flagged
  assert.equal(detectPriceOutlier(1500, 1000, PRICE_OUTLIER_THRESHOLD), null);
});

test("entered 51% above expected → flagged as 'above'", () => {
  const outlier = detectPriceOutlier(1510, 1000, PRICE_OUTLIER_THRESHOLD);
  assert.ok(outlier);
  assert.equal(outlier.direction, "above");
  assert.equal(outlier.expected, 1000);
});

test("entered 50% below expected (edge) → null", () => {
  // 1000 → 500 is exactly threshold (|−0.5| = 0.5) → not flagged
  assert.equal(detectPriceOutlier(500, 1000, PRICE_OUTLIER_THRESHOLD), null);
});

test("entered 51% below expected → flagged as 'below'", () => {
  const outlier = detectPriceOutlier(490, 1000, PRICE_OUTLIER_THRESHOLD);
  assert.ok(outlier);
  assert.equal(outlier.direction, "below");
});

test("extreme over-price (voice typo e.g. 100×) → flagged", () => {
  const outlier = detectPriceOutlier(50000, 500, PRICE_OUTLIER_THRESHOLD);
  assert.ok(outlier);
  assert.equal(outlier.direction, "above");
});

test("extreme under-price → flagged", () => {
  const outlier = detectPriceOutlier(5, 500, PRICE_OUTLIER_THRESHOLD);
  assert.ok(outlier);
  assert.equal(outlier.direction, "below");
});

test("zero or negative entered → null (guarded)", () => {
  assert.equal(detectPriceOutlier(0, 1000, PRICE_OUTLIER_THRESHOLD), null);
  assert.equal(detectPriceOutlier(-100, 1000, PRICE_OUTLIER_THRESHOLD), null);
});

test("zero or negative expected → null (guarded — catalog price missing)", () => {
  assert.equal(detectPriceOutlier(1000, 0, PRICE_OUTLIER_THRESHOLD), null);
  assert.equal(detectPriceOutlier(1000, -100, PRICE_OUTLIER_THRESHOLD), null);
});

test("NaN inputs → null", () => {
  assert.equal(detectPriceOutlier(NaN, 1000, PRICE_OUTLIER_THRESHOLD), null);
  assert.equal(detectPriceOutlier(1000, NaN, PRICE_OUTLIER_THRESHOLD), null);
});

test("custom threshold honored (±30%)", () => {
  // 1000 → 1350 is +35% which exceeds 30% but not 50%.
  assert.equal(detectPriceOutlier(1350, 1000, 0.5), null);
  const outlier = detectPriceOutlier(1350, 1000, 0.3);
  assert.ok(outlier);
  assert.equal(outlier.direction, "above");
});

// ── buildPriceOutlierLabel ─────────────────────────────────────────

test("label renders the expected catalog price and up arrow for above", () => {
  const label = buildPriceOutlierLabel({ expected: 6200, direction: "above" }, "ARS");
  assert.ok(label.startsWith("⚠ Precio ↑"));
  assert.ok(label.includes("catálogo"));
  assert.ok(label.includes("6") && label.includes("200"));
});

test("label uses down arrow for below", () => {
  const label = buildPriceOutlierLabel({ expected: 6200, direction: "below" }, "ARS");
  assert.ok(label.includes("↓"));
});

test("label falls back to ARS when currency empty", () => {
  const label = buildPriceOutlierLabel({ expected: 100, direction: "above" }, "");
  assert.ok(label.includes("catálogo"));
});
