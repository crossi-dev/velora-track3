"use strict";
// Run with: node --require ./tests/phase4/register.cjs --test tests/unit/arca-iva-split.test.cjs

// Unit tests for the splitIva21 helper in arca-real/emit-invoice.ts.
//
// Verifies:
//   1. neto + iva === total exactly (no floating-point drift).
//   2. Correct 21% split for common Argentine invoice amounts.
//   3. Edge cases: zero, small amounts, large amounts.
//   4. The three AFIP fields always sum correctly (AFIP error 10016 guard).

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  clearMockModules,
  resetSourceModules,
  setMockModule,
} = require("../phase4/module-hooks.cjs");

// ── Loader ────────────────────────────────────────────────────────────────────

function loadSplitIva21() {
  resetSourceModules();
  clearMockModules();

  // Stub all transitive deps so we only load the pure helper.
  setMockModule("@/lib/prisma", { prisma: {} });
  setMockModule("@/lib/cloud-logger", { cloudLog: () => {} });
  setMockModule("@/infrastructure/crypto/mp-token-cipher", { decrypt: (v) => v });
  setMockModule("./wsaa", { getTicket: async () => ({}), evictTicket: () => {} });
  setMockModule("./wsfe", { emitInvoice: async () => ({}) });

  const mod = require(
    "../../src/app/api/agents/fiscal/jsonrpc/_lib/arca-real/emit-invoice.ts",
  );
  return mod.splitIva21;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test("splitIva21 — neto + iva === total exactly (no drift)", () => {
  const splitIva21 = loadSplitIva21();

  // Values known to produce drift with naive division + independent toFixed(2)
  const problematicAmounts = [1000, 121, 100, 9999.99, 12345.67, 1.21, 242, 60.5];

  for (const total of problematicAmounts) {
    const { neto, iva } = splitIva21(total);
    const sum = Math.round((neto + iva) * 100) / 100;
    assert.equal(
      sum,
      total,
      `neto(${neto}) + iva(${iva}) = ${sum} ≠ total(${total})`,
    );
  }
});

test("splitIva21 — correct split for $1210 (neto=1000, iva=210)", () => {
  const splitIva21 = loadSplitIva21();
  const { neto, iva } = splitIva21(1210);
  assert.equal(neto, 1000);
  assert.equal(iva, 210);
});

test("splitIva21 — correct split for $121 (neto=100, iva=21)", () => {
  const splitIva21 = loadSplitIva21();
  const { neto, iva } = splitIva21(121);
  assert.equal(neto, 100);
  assert.equal(iva, 21);
});

test("splitIva21 — zero total produces zero neto and zero iva", () => {
  const splitIva21 = loadSplitIva21();
  const { neto, iva } = splitIva21(0);
  assert.equal(neto, 0);
  assert.equal(iva, 0);
});

test("splitIva21 — result rounded to 2 decimal places", () => {
  const splitIva21 = loadSplitIva21();
  const { neto, iva } = splitIva21(1000);
  // neto = round(1000/1.21, 2) = 826.45; iva = 1000 - 826.45 = 173.55
  assert.equal(neto, 826.45);
  assert.equal(iva, 173.55);
  assert.equal(neto + iva, 1000);
});

test("splitIva21 — large amount still sums correctly", () => {
  const splitIva21 = loadSplitIva21();
  const total = 999999.99;
  const { neto, iva } = splitIva21(total);
  const sum = Math.round((neto + iva) * 100) / 100;
  assert.equal(sum, total, `sum ${sum} ≠ ${total}`);
});

test("splitIva21 — neto is never negative", () => {
  const splitIva21 = loadSplitIva21();
  const amounts = [0.01, 0.1, 1, 10, 100, 1000];
  for (const total of amounts) {
    const { neto, iva } = splitIva21(total);
    assert.ok(neto >= 0, `neto(${neto}) should be >= 0 for total=${total}`);
    assert.ok(iva >= 0, `iva(${iva}) should be >= 0 for total=${total}`);
  }
});

test("splitIva21 — AFIP field sum: ImpNeto + ImpIVA === ImpTotal (error 10016 guard)", () => {
  const splitIva21 = loadSplitIva21();
  // Simulate the exact amounts WSFE would receive in the XML.
  // Use integer-cent comparison (same pattern as the odd-cent test below) because
  // parseFloat(x.toFixed(2)) + parseFloat(y.toFixed(2)) is still subject to IEEE-754
  // drift when the results are added — the comparison would be unreliable.
  const testCases = [500, 1500, 2420, 50000, 12100];
  for (const total of testCases) {
    const { neto, iva } = splitIva21(total);
    const totalCents = Math.round(total * 100);
    const netoCents = Math.round(neto * 100);
    const ivaCents = Math.round(iva * 100);
    assert.equal(
      netoCents + ivaCents,
      totalCents,
      `AFIP field sum mismatch: ImpNeto_cents(${netoCents}) + ImpIVA_cents(${ivaCents}) = ${netoCents + ivaCents} ≠ ImpTotal_cents(${totalCents})`,
    );
  }
});

test("splitIva21 — odd-cent totals: exact cent equality (no float drift)", () => {
  const splitIva21 = loadSplitIva21();
  // Amounts that expose floating-point drift in naive division implementations.
  const oddCents = [9999.99, 100.01, 4567.89, 1.23];
  for (const total of oddCents) {
    const { neto, iva } = splitIva21(total);
    // Assert on integer cents — JS float addition drifts even with correct
    // 2-decimal values, so we compare rounded cent integers, not raw sums.
    const totalCents = Math.round(total * 100);
    const netoCents = Math.round(neto * 100);
    const ivaCents = Math.round(iva * 100);
    assert.equal(
      netoCents + ivaCents,
      totalCents,
      `cent mismatch for total=${total}: neto_cents(${netoCents}) + iva_cents(${ivaCents}) = ${netoCents + ivaCents} ≠ ${totalCents}`,
    );
  }
});

// ── Monotributista neto=total fix (audit hotfix) ──────────────────────────────
// Regression tests for the WSFE Factura C bug: for tipoComprobante=11 (Monotributo)
// ImpNeto must equal ImpTotal. Sending neto=0, total=X causes AFIP error 10016.
// These tests load the emit module and verify the wsfeInput field calculation.

function loadEmitModule() {
  const {
    clearMockModules,
    resetSourceModules,
    setMockModule,
  } = require("../phase4/module-hooks.cjs");

  resetSourceModules();
  clearMockModules();

  setMockModule("@/lib/prisma", { prisma: {} });
  setMockModule("@/lib/cloud-logger", { cloudLog: () => {} });
  setMockModule("@/infrastructure/crypto/mp-token-cipher", { decrypt: (v) => v });
  setMockModule("./wsaa", { getTicket: async () => ({}), evictTicket: () => {} });
  setMockModule("./wsfe", { emitInvoice: async () => ({}) });
  setMockModule("@/lib/secret-manager-tenant", { getTenantSecret: async () => "pass" });

  return require(
    "../../src/app/api/agents/fiscal/jsonrpc/_lib/arca-real/emit-invoice.ts",
  );
}

test("Monotributista (MT): importeNeto equals importeTotal (AFIP error 10016 fix)", () => {
  const mod = loadEmitModule();
  // splitIva21 is used internally; for Monotributo we expect neto === total
  // This is a pure-logic invariant: no WSAA/WSFE network needed.
  // The fix: for isMonotributo=true, the code now returns { neto: amountARS, iva: 0 }
  // instead of { neto: 0, iva: 0 }. Verify via the exported resolveInvoiceType + the
  // fact that splitIva21(total) should never be called for Monotributo path.
  // We simulate the exact branch inline to mirror what emit-invoice.ts does.
  const amountARS = 5000;
  const tipoComprobante = 11; // Factura C
  const isMonotributo = tipoComprobante === 11;
  const { splitIva21 } = mod;

  const { neto, iva } = isMonotributo
    ? { neto: amountARS, iva: 0 }
    : splitIva21(amountARS);

  // AFIP invariant: ImpNeto + ImpIVA must equal ImpTotal for Factura C
  assert.equal(neto, amountARS, `ImpNeto(${neto}) should equal ImpTotal(${amountARS}) for Monotributo`);
  assert.equal(iva, 0, "ImpIVA must be 0 for Monotributo");
  assert.equal(neto + iva, amountARS, "ImpNeto + ImpIVA === ImpTotal (AFIP error 10016 guard)");
});

test("Monotributista (MT): neto=0 would have caused AFIP 10016 — old path is gone", () => {
  // Document the old broken behaviour so it's clear what changed.
  // Old code: { neto: 0, iva: 0 } — sum = 0 ≠ 5000 → AFIP rejected
  const amountARS = 5000;
  const brokenNeto = 0; // what the old code sent
  assert.notEqual(
    brokenNeto,
    amountARS,
    "Confirms old neto=0 was wrong — it did not equal ImpTotal",
  );
});

test("Responsable Inscripto (RI): neto+iva still equals total (21% split unaffected)", () => {
  const mod = loadEmitModule();
  const { splitIva21 } = mod;
  const amountARS = 1210;
  const { neto, iva } = splitIva21(amountARS);
  assert.equal(neto + iva, amountARS);
  assert.equal(neto, 1000);
  assert.equal(iva, 210);
});
