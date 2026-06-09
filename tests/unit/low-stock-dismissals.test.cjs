const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildLowStockDismissalKey,
  parseDismissedLowStockKeys,
  pruneDismissedLowStockKeys,
} = require("../../src/app/dashboard/lib/low-stock-dismissals.ts");

test("buildLowStockDismissalKey usa id y stock actual", () => {
  assert.equal(buildLowStockDismissalKey({ id: "prod-1", stock: 2 }), "prod-1:2");
});

test("parseDismissedLowStockKeys conserva dismissals del mismo estado de stock", () => {
  const result = parseDismissedLowStockKeys(JSON.stringify(["prod-1:2", "prod-2:0"]), [
    { id: "prod-1", stock: 2 },
    { id: "prod-2", stock: 0 },
  ]);

  assert.deepEqual(result, ["prod-1:2", "prod-2:0"]);
});

test("parseDismissedLowStockKeys descarta dismissals cuando cambia el stock", () => {
  const result = parseDismissedLowStockKeys(JSON.stringify(["prod-1:2", "prod-2:0"]), [
    { id: "prod-1", stock: 1 },
    { id: "prod-2", stock: 0 },
  ]);

  assert.deepEqual(result, ["prod-2:0"]);
});

test("parseDismissedLowStockKeys tolera JSON inválido", () => {
  const result = parseDismissedLowStockKeys("no-es-json", [{ id: "prod-1", stock: 2 }]);

  assert.deepEqual(result, []);
});

test("pruneDismissedLowStockKeys elimina duplicados y claves ajenas", () => {
  const result = pruneDismissedLowStockKeys(["prod-1:2", "prod-1:2", "prod-9:1"], [
    { id: "prod-1", stock: 2 },
  ]);

  assert.deepEqual(result, ["prod-1:2"]);
});
