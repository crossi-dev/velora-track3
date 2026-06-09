const assert = require("node:assert/strict");
const test = require("node:test");

const {
  detectStockShortfall: domainDetectStockShortfall,
} = require("../../src/domain/rules/index.ts");

const {
  buildStockShortfallLabel,
} = require("../../src/app/dashboard/lib/stock-shortfall-label.ts");

// Replicates the former wrapper's allowNegativeStock guard.
function detectStockShortfall(requested, available, allowNegativeStock) {
  if (allowNegativeStock) return null;
  return domainDetectStockShortfall(requested, available);
}

test("requested <= available → no shortfall", () => {
  assert.equal(detectStockShortfall(2, 10, false), null);
  assert.equal(detectStockShortfall(10, 10, false), null);
});

test("requested > available + allowNegativeStock OFF → shortfall flagged", () => {
  const s = detectStockShortfall(5, 2, false);
  assert.ok(s);
  assert.equal(s.available, 2);
  assert.equal(s.requested, 5);
});

test("requested > available + allowNegativeStock ON → null (user opted in)", () => {
  assert.equal(detectStockShortfall(5, 2, true), null);
});

test("available = 0 + requested > 0 + allowNegative OFF → shortfall with 0 available", () => {
  const s = detectStockShortfall(1, 0, false);
  assert.ok(s);
  assert.equal(s.available, 0);
});

test("NaN guards → null", () => {
  assert.equal(detectStockShortfall(NaN, 10, false), null);
  assert.equal(detectStockShortfall(5, NaN, false), null);
});

test("label for zero stock calls it out explicitly", () => {
  const label = buildStockShortfallLabel({ available: 0, requested: 1 });
  assert.ok(label.includes("Sin stock"));
  assert.ok(label.includes("0"));
});

test("label for low stock uses 'unidades' plural", () => {
  const label = buildStockShortfallLabel({ available: 3, requested: 5 });
  assert.ok(label.includes("3 unidades disponibles"));
});

test("label for 1 available uses singular", () => {
  const label = buildStockShortfallLabel({ available: 1, requested: 5 });
  assert.ok(label.includes("1 unidad disponibles") || label.includes("1 unidad"));
});
