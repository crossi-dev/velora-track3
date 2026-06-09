const assert = require("node:assert/strict");
const test = require("node:test");

const {
  computeTodaySummary,
  getArgentinaDateString,
  getArgentinaDayBounds,
} = require("../../src/app/dashboard/lib/today-summary.ts");

// Argentina is UTC-3 fixed. Helper for tests: build an ISO date string for
// a given AR-local wall-clock time, returning a UTC ISO that represents that
// AR moment. e.g. "2026-04-26 14:30 AR" → "2026-04-26T17:30:00.000Z".
function arIso(year, month, day, hour = 12, minute = 0) {
  // AR = UTC-3 → AR hour 12 = UTC hour 15. Build via Date.UTC + 3h offset.
  const utcMs = Date.UTC(year, month - 1, day, hour + 3, minute, 0, 0);
  return new Date(utcMs).toISOString();
}

// Reference "now" for all tests: 2026-04-26 14:00 AR (mid-afternoon).
// At 14:00 AR the AR day is 2026-04-26; the UTC day is 2026-04-26 17:00.
const NOW_AR_14H = arIso(2026, 4, 26, 14, 0);
const NOW_MS = new Date(NOW_AR_14H).getTime();

test("getArgentinaDateString: midday returns the AR calendar date", () => {
  assert.equal(getArgentinaDateString(NOW_MS), "2026-04-26");
});

test("getArgentinaDateString: AR boundary 23:59 is the same day as 14:00", () => {
  const lateAR = new Date(arIso(2026, 4, 26, 23, 59)).getTime();
  assert.equal(getArgentinaDateString(lateAR), "2026-04-26");
});

test("getArgentinaDateString: AR boundary 00:01 of next day rolls to the next day", () => {
  const earlyNextAR = new Date(arIso(2026, 4, 27, 0, 1)).getTime();
  assert.equal(getArgentinaDateString(earlyNextAR), "2026-04-27");
});

test("getArgentinaDateString: UTC midnight (= 21:00 AR previous day) stays on the previous AR day", () => {
  // 2026-04-26 00:00 UTC = 2026-04-25 21:00 AR
  const utcMidnight = Date.UTC(2026, 3, 26, 0, 0, 0, 0);
  assert.equal(getArgentinaDateString(utcMidnight), "2026-04-25");
});

test("getArgentinaDayBounds: returns dateAR and a 24h window in UTC ms", () => {
  const bounds = getArgentinaDayBounds(NOW_MS);
  assert.equal(bounds.dateAR, "2026-04-26");
  // Window must contain NOW_MS
  assert.ok(bounds.startMs <= NOW_MS && NOW_MS <= bounds.endMs);
  // Width is exactly one day minus 1ms
  assert.equal(bounds.endMs - bounds.startMs + 1, 24 * 60 * 60 * 1000);
  // Start corresponds to AR 00:00 on that date → 03:00 UTC
  assert.equal(new Date(bounds.startMs).toISOString(), "2026-04-26T03:00:00.000Z");
});

test("computeTodaySummary: empty input → all zeros, hasMovements=false", () => {
  const result = computeTodaySummary([], NOW_MS);
  assert.deepEqual(result, { sales: 0, expenses: 0, net: 0, hasMovements: false });
});

test("computeTodaySummary: only sales today → expenses=0, net=sales", () => {
  const movements = [
    { id: "m1", type: "sale", description: "Venta 1", amount: 1500, date: arIso(2026, 4, 26, 10) },
    { id: "m2", type: "sale", description: "Venta 2", amount: 800, date: arIso(2026, 4, 26, 11) },
  ];
  const result = computeTodaySummary(movements, NOW_MS);
  assert.equal(result.sales, 2300);
  assert.equal(result.expenses, 0);
  assert.equal(result.net, 2300);
  assert.equal(result.hasMovements, true);
});

test("computeTodaySummary: only expenses today → sales=0, net is negative", () => {
  const movements = [
    { id: "m1", type: "purchase", description: "Compra mercadería", amount: -500, date: arIso(2026, 4, 26, 9) },
    { id: "m2", type: "tax", description: "Impuesto", amount: -200, date: arIso(2026, 4, 26, 12) },
  ];
  const result = computeTodaySummary(movements, NOW_MS);
  assert.equal(result.sales, 0);
  assert.equal(result.expenses, 700);
  assert.equal(result.net, -700);
  assert.equal(result.hasMovements, true);
});

test("computeTodaySummary: mixed today → ventas + gastos + diferencia computed correctly", () => {
  const movements = [
    { id: "m1", type: "sale", description: "Venta", amount: 2000, date: arIso(2026, 4, 26, 10) },
    { id: "m2", type: "purchase", description: "Compra", amount: -800, date: arIso(2026, 4, 26, 11) },
    { id: "m3", type: "sale", description: "Venta", amount: 1200, date: arIso(2026, 4, 26, 13) },
    { id: "m4", type: "salary", description: "Sueldo", amount: -1500, date: arIso(2026, 4, 26, 13, 30) },
  ];
  const result = computeTodaySummary(movements, NOW_MS);
  assert.equal(result.sales, 3200);
  assert.equal(result.expenses, 2300);
  assert.equal(result.net, 900);
  assert.equal(result.hasMovements, true);
});

test("computeTodaySummary: income manual SÍ suma a sales (tratado igual que type=sale)", () => {
  // Post-18953507: income was added to the sales bucket alongside sale.
  // Rationale: manual income (e.g. owner cash top-up) is cash-in and
  // increases the net the same way a sale does. The type distinction is
  // preserved at the domain level but both feed the daily sales total.
  const movements = [
    { id: "m1", type: "income", description: "Ingreso manual", amount: 5000, date: arIso(2026, 4, 26, 9) },
    { id: "m2", type: "sale", description: "Venta", amount: 1000, date: arIso(2026, 4, 26, 10) },
  ];
  const result = computeTodaySummary(movements, NOW_MS);
  assert.equal(result.sales, 6000);
  assert.equal(result.expenses, 0);
  assert.equal(result.net, 6000);
  assert.equal(result.hasMovements, true);
});

test("computeTodaySummary: movimientos de ayer no cuentan (filtro de ventana AR)", () => {
  const movements = [
    { id: "m1", type: "sale", description: "Venta ayer 23:00 AR", amount: 5000, date: arIso(2026, 4, 25, 23) },
    { id: "m2", type: "sale", description: "Venta hoy 10:00 AR", amount: 1000, date: arIso(2026, 4, 26, 10) },
  ];
  const result = computeTodaySummary(movements, NOW_MS);
  assert.equal(result.sales, 1000);
  assert.equal(result.hasMovements, true);
});

test("computeTodaySummary: movimiento exactamente en 00:00 AR cuenta como hoy", () => {
  const movements = [
    { id: "m1", type: "sale", description: "Venta apertura", amount: 100, date: arIso(2026, 4, 26, 0, 0) },
  ];
  const result = computeTodaySummary(movements, NOW_MS);
  assert.equal(result.sales, 100);
});

test("computeTodaySummary: movimiento en 23:59:59 AR cuenta como hoy", () => {
  // 2026-04-26 23:59 AR
  const lateAR = new Date(arIso(2026, 4, 26, 23, 59)).getTime();
  const movements = [
    { id: "m1", type: "sale", description: "Venta cierre", amount: 200, date: new Date(lateAR).toISOString() },
  ];
  // Ahora son 14:00 AR del mismo día → la venta de las 23:59 AR está EN el futuro
  // pero EN el mismo día calenjuan. Debe contar.
  const result = computeTodaySummary(movements, NOW_MS);
  assert.equal(result.sales, 200);
});

test("computeTodaySummary: amount no finito se ignora pero hasMovements=true si la fecha coincide", () => {
  const movements = [
    { id: "m1", type: "sale", description: "Bad row", amount: NaN, date: arIso(2026, 4, 26, 10) },
    { id: "m2", type: "sale", description: "Otra", amount: Infinity, date: arIso(2026, 4, 26, 11) },
  ];
  const result = computeTodaySummary(movements, NOW_MS);
  assert.equal(result.sales, 0);
  assert.equal(result.expenses, 0);
  assert.equal(result.hasMovements, true);
});

test("computeTodaySummary: fecha inválida se descarta (no aporta a hasMovements)", () => {
  const movements = [
    { id: "m1", type: "sale", description: "Bad date", amount: 100, date: "not-a-date" },
  ];
  const result = computeTodaySummary(movements, NOW_MS);
  assert.equal(result.hasMovements, false);
});

test("computeTodaySummary: adjustment positivo suma a sales (efectivo entrante)", () => {
  // Post-18953507: positive cash adjustments (e.g. owner funds the till)
  // are treated as cash-in → added to sales so net increases correctly.
  // Negative adjustments go to expenses. Types that are neither sale/income
  // nor adjustment and have positive amounts are ignored (not cash-in events).
  const movements = [
    { id: "m1", type: "adjustment", description: "Ajuste positivo", amount: 500, date: arIso(2026, 4, 26, 10) },
  ];
  const result = computeTodaySummary(movements, NOW_MS);
  assert.equal(result.sales, 500);
  assert.equal(result.expenses, 0);
  assert.equal(result.net, 500);
  assert.equal(result.hasMovements, true);
});

test("computeTodaySummary: movimiento con tipo sale pero monto negativo (anomalía) suma a sales, no a expenses", () => {
  // Post-18953507: the sale branch (type==="sale") is checked first and adds
  // the amount literally. A negative-amount sale never reaches the
  // else-if (amount < 0) expenses branch, so expenses stays 0.
  // Pinning this behavior: if a bad row reaches this function with type=sale
  // and amount<0, the correct fix is upstream data validation, not here.
  const movements = [
    { id: "m1", type: "sale", description: "Venta anómala", amount: -100, date: arIso(2026, 4, 26, 10) },
  ];
  const result = computeTodaySummary(movements, NOW_MS);
  assert.equal(result.sales, -100);
  assert.equal(result.expenses, 0);
  assert.equal(result.net, -100);
});
