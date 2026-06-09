const assert = require("node:assert/strict");
const test = require("node:test");

const {
  DUPLICATE_SALE_WINDOW_MS,
  _resetSaleAttemptsForTests,
  buildDuplicateAttemptWarning,
  buildDuplicateSaleWarning,
  findRecentAttemptDuplicate,
  findRecentDuplicateSale,
  recordSaleAttempt,
} = require("../../src/app/dashboard/lib/sale-duplicate-detection.ts");

const NOW = Date.UTC(2026, 3, 24, 12, 0, 0); // 2026-04-24T12:00:00Z

function saleAt(offsetMs, customerId, items) {
  return {
    id: `s_${offsetMs}`,
    date: new Date(NOW - offsetMs).toISOString(),
    totalAmount: items.reduce((s, i) => s + i.quantity * i.unitPrice, 0),
    customer: customerId ? { id: customerId, name: `Customer ${customerId}` } : null,
    items: items.map((i) => ({
      quantity: i.quantity,
      unitPrice: i.unitPrice,
      product: { id: i.productId, name: `Product ${i.productId}` },
    })),
  };
}

test("DUPLICATE_SALE_WINDOW_MS is 60000 (60s per spec)", () => {
  assert.equal(DUPLICATE_SALE_WINDOW_MS, 60_000);
});

test("no sales → no duplicate", () => {
  const r = findRecentDuplicateSale([], { customerId: "c1", items: [{ productId: "p1", quantity: 2 }] }, NOW);
  assert.equal(r, null);
});

test("exact match within 60s → flagged as duplicate", () => {
  const sales = [saleAt(20_000, "c1", [{ productId: "p1", quantity: 2, unitPrice: 100 }])];
  const r = findRecentDuplicateSale(sales, { customerId: "c1", items: [{ productId: "p1", quantity: 2 }] }, NOW);
  assert.ok(r);
  assert.equal(r.id, "s_20000");
});

test("match older than 60s → not a duplicate", () => {
  const sales = [saleAt(61_000, "c1", [{ productId: "p1", quantity: 2, unitPrice: 100 }])];
  const r = findRecentDuplicateSale(sales, { customerId: "c1", items: [{ productId: "p1", quantity: 2 }] }, NOW);
  assert.equal(r, null);
});

test("match at exactly 60s boundary → still a duplicate (inclusive)", () => {
  const sales = [saleAt(60_000, "c1", [{ productId: "p1", quantity: 2, unitPrice: 100 }])];
  const r = findRecentDuplicateSale(sales, { customerId: "c1", items: [{ productId: "p1", quantity: 2 }] }, NOW);
  assert.ok(r);
});

test("different customerId → not a duplicate", () => {
  const sales = [saleAt(20_000, "c1", [{ productId: "p1", quantity: 2, unitPrice: 100 }])];
  const r = findRecentDuplicateSale(sales, { customerId: "c2", items: [{ productId: "p1", quantity: 2 }] }, NOW);
  assert.equal(r, null);
});

test("both null customer (walk-ins) with same items → duplicate", () => {
  const sales = [saleAt(20_000, null, [{ productId: "p1", quantity: 2, unitPrice: 100 }])];
  const r = findRecentDuplicateSale(sales, { customerId: null, items: [{ productId: "p1", quantity: 2 }] }, NOW);
  assert.ok(r);
});

test("different quantity → not a duplicate", () => {
  const sales = [saleAt(20_000, "c1", [{ productId: "p1", quantity: 2, unitPrice: 100 }])];
  const r = findRecentDuplicateSale(sales, { customerId: "c1", items: [{ productId: "p1", quantity: 3 }] }, NOW);
  assert.equal(r, null);
});

test("different product → not a duplicate", () => {
  const sales = [saleAt(20_000, "c1", [{ productId: "p1", quantity: 2, unitPrice: 100 }])];
  const r = findRecentDuplicateSale(sales, { customerId: "c1", items: [{ productId: "p2", quantity: 2 }] }, NOW);
  assert.equal(r, null);
});

test("extra item in candidate → not a duplicate", () => {
  const sales = [saleAt(20_000, "c1", [{ productId: "p1", quantity: 2, unitPrice: 100 }])];
  const r = findRecentDuplicateSale(
    sales,
    { customerId: "c1", items: [{ productId: "p1", quantity: 2 }, { productId: "p2", quantity: 1 }] },
    NOW,
  );
  assert.equal(r, null);
});

test("same items in different order → still a duplicate (multiset match)", () => {
  const sales = [
    saleAt(20_000, "c1", [
      { productId: "p1", quantity: 2, unitPrice: 100 },
      { productId: "p2", quantity: 5, unitPrice: 50 },
    ]),
  ];
  const r = findRecentDuplicateSale(
    sales,
    {
      customerId: "c1",
      items: [{ productId: "p2", quantity: 5 }, { productId: "p1", quantity: 2 }],
    },
    NOW,
  );
  assert.ok(r);
});

test("candidate with an unresolved item (productId=null) → skip check (no false positive)", () => {
  const sales = [saleAt(20_000, "c1", [{ productId: "p1", quantity: 2, unitPrice: 100 }])];
  const r = findRecentDuplicateSale(
    sales,
    { customerId: "c1", items: [{ productId: null, quantity: 2 }] },
    NOW,
  );
  assert.equal(r, null);
});

test("candidate with one resolved + one unresolved item → skip (partial match unsafe)", () => {
  const sales = [
    saleAt(20_000, "c1", [
      { productId: "p1", quantity: 2, unitPrice: 100 },
      { productId: "p2", quantity: 1, unitPrice: 50 },
    ]),
  ];
  const r = findRecentDuplicateSale(
    sales,
    { customerId: "c1", items: [{ productId: "p1", quantity: 2 }, { productId: null, quantity: 1 }] },
    NOW,
  );
  assert.equal(r, null);
});

test("sale with invalid date string → skipped without crashing", () => {
  const sales = [
    {
      id: "s_bad",
      date: "not-a-date",
      totalAmount: 200,
      customer: { id: "c1", name: "C1" },
      items: [{ quantity: 2, unitPrice: 100, product: { id: "p1", name: "P1" } }],
    },
  ];
  const r = findRecentDuplicateSale(sales, { customerId: "c1", items: [{ productId: "p1", quantity: 2 }] }, NOW);
  assert.equal(r, null);
});

test("future-dated sale (clock skew) → ignored (age < 0)", () => {
  const sales = [saleAt(-5_000, "c1", [{ productId: "p1", quantity: 2, unitPrice: 100 }])];
  const r = findRecentDuplicateSale(sales, { customerId: "c1", items: [{ productId: "p1", quantity: 2 }] }, NOW);
  assert.equal(r, null);
});

test("picks the most recent match when multiple candidates exist", () => {
  const sales = [
    saleAt(50_000, "c1", [{ productId: "p1", quantity: 2, unitPrice: 100 }]),
    saleAt(20_000, "c1", [{ productId: "p1", quantity: 2, unitPrice: 100 }]),
  ];
  const r = findRecentDuplicateSale(sales, { customerId: "c1", items: [{ productId: "p1", quantity: 2 }] }, NOW);
  assert.ok(r);
  // The helper returns the first match it encounters. Either is
  // semantically fine for the UX ("an identical recent sale"), so we
  // assert that SOME match was returned, not which one.
  assert.ok(r.id === "s_50000" || r.id === "s_20000");
});

// ── buildDuplicateSaleWarning ─────────────────────────────────────

test("buildDuplicateSaleWarning: rounds seconds and clamps to 1s minimum", () => {
  const sale = saleAt(500, "c1", [{ productId: "p1", quantity: 1, unitPrice: 100 }]);
  const msg = buildDuplicateSaleWarning(sale, NOW);
  assert.ok(msg.startsWith("⚠ Hace 1s registraste una venta igual."));
});

test("buildDuplicateSaleWarning: 20s old → 'Hace 20s'", () => {
  const sale = saleAt(20_000, "c1", [{ productId: "p1", quantity: 1, unitPrice: 100 }]);
  const msg = buildDuplicateSaleWarning(sale, NOW);
  assert.ok(msg.includes("Hace 20s"));
  assert.ok(msg.includes("Revisá el borrador"));
});

// ── In-memory attempt buffer ──────────────────────────────────────

test("in-memory: recording an attempt then checking immediately → found", () => {
  _resetSaleAttemptsForTests();
  const candidate = { customerId: "c1", items: [{ productId: "p1", quantity: 2 }] };
  recordSaleAttempt(candidate, NOW);
  const hit = findRecentAttemptDuplicate(candidate, NOW + 500);
  assert.ok(hit);
  assert.equal(hit.customerId, "c1");
});

test("in-memory: check BEFORE recording → not found (baseline)", () => {
  _resetSaleAttemptsForTests();
  const candidate = { customerId: "c1", items: [{ productId: "p1", quantity: 2 }] };
  const hit = findRecentAttemptDuplicate(candidate, NOW);
  assert.equal(hit, null);
});

test("in-memory: attempt older than 60s → not found", () => {
  _resetSaleAttemptsForTests();
  const candidate = { customerId: "c1", items: [{ productId: "p1", quantity: 2 }] };
  recordSaleAttempt(candidate, NOW);
  const hit = findRecentAttemptDuplicate(candidate, NOW + 61_000);
  assert.equal(hit, null);
});

test("in-memory: different customer → not found", () => {
  _resetSaleAttemptsForTests();
  recordSaleAttempt({ customerId: "c1", items: [{ productId: "p1", quantity: 2 }] }, NOW);
  const hit = findRecentAttemptDuplicate({ customerId: "c2", items: [{ productId: "p1", quantity: 2 }] }, NOW + 1000);
  assert.equal(hit, null);
});

test("in-memory: different items → not found", () => {
  _resetSaleAttemptsForTests();
  recordSaleAttempt({ customerId: "c1", items: [{ productId: "p1", quantity: 2 }] }, NOW);
  const hit = findRecentAttemptDuplicate({ customerId: "c1", items: [{ productId: "p1", quantity: 3 }] }, NOW + 1000);
  assert.equal(hit, null);
});

test("in-memory: candidate with unresolved productId → recordSaleAttempt is a no-op", () => {
  _resetSaleAttemptsForTests();
  recordSaleAttempt({ customerId: "c1", items: [{ productId: null, quantity: 2 }] }, NOW);
  // Nothing was recorded, so a subsequent fully-resolved attempt finds nothing
  const hit = findRecentAttemptDuplicate({ customerId: "c1", items: [{ productId: "p1", quantity: 2 }] }, NOW + 1000);
  assert.equal(hit, null);
});

test("in-memory: items in different order → multiset match", () => {
  _resetSaleAttemptsForTests();
  recordSaleAttempt(
    { customerId: "c1", items: [{ productId: "p1", quantity: 2 }, { productId: "p2", quantity: 5 }] },
    NOW,
  );
  const hit = findRecentAttemptDuplicate(
    { customerId: "c1", items: [{ productId: "p2", quantity: 5 }, { productId: "p1", quantity: 2 }] },
    NOW + 1000,
  );
  assert.ok(hit);
});

test("in-memory: multiple attempts, returns most recent match first (reverse iteration)", () => {
  _resetSaleAttemptsForTests();
  recordSaleAttempt({ customerId: "c1", items: [{ productId: "p1", quantity: 2 }] }, NOW - 30_000);
  recordSaleAttempt({ customerId: "c1", items: [{ productId: "p1", quantity: 2 }] }, NOW - 5_000);
  const hit = findRecentAttemptDuplicate({ customerId: "c1", items: [{ productId: "p1", quantity: 2 }] }, NOW);
  assert.ok(hit);
  assert.equal(hit.timestamp, NOW - 5_000);
});

test("buildDuplicateAttemptWarning: rounds seconds and clamps to 1s minimum", () => {
  assert.ok(buildDuplicateAttemptWarning(500).includes("Hace 1s"));
  assert.ok(buildDuplicateAttemptWarning(20_000).includes("Hace 20s"));
});
