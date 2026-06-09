const assert = require("node:assert/strict");
const test = require("node:test");

const { buildStockLoadSuccessMessage } = require("../../src/app/dashboard/lib/stock-load-chat.ts");

test("buildStockLoadSuccessMessage arma el mensaje base de stock", () => {
  assert.equal(
    buildStockLoadSuccessMessage("3 Filtro, 2 Rulemán"),
    "Listo, actualicé el stock:\n3 Filtro, 2 Rulemán"
  );
});

test("buildStockLoadSuccessMessage agrega la solicitud si existe", () => {
  assert.equal(
    buildStockLoadSuccessMessage("3 Filtro", "SOL-0001"),
    "Listo, actualicé el stock:\n3 Filtro\nTambién generé la solicitud SOL-0001."
  );
});
