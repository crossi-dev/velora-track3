// Regression tests for NLU Layer 1 — Step 1 Judgment-Day fixes.
// Covers: C1, H1, H2, M1, M3, M4.
// Run: node --require ./tests/phase4/register.cjs --test tests/unit/nlu-fast-path-step1-regression.test.cjs

const assert = require("node:assert/strict");
const test = require("node:test");

// ── Imports ───────────────────────────────────────────────────────────────────

const { detectStockQueryFastPath, detectStockSummaryFastPath } =
  require("../../src/app/api/business-assistant/_lib/nlu/stock-query-fast-path.ts");

const { detectPaymentLinkFastPath } =
  require("../../src/app/api/business-assistant/_lib/nlu/payment-link-fast-path.ts");

const { looksLikeUndoRequest } =
  require("../../src/app/api/business-assistant/_lib/confirmation.ts");

const { detectSaleCreateFastPath, HACELE_VENTA_RE } =
  require("../../src/app/api/business-assistant/_lib/nlu/sale-create-fast-path.ts");

const { looksLikeCreateSupplier } =
  require("../../src/app/api/business-assistant/_lib/handlers/owner-only-detectors.ts");

const { hasInvoiceReference, looksLikeInvoiceLookupRequest } =
  require("../../src/app/api/business-assistant/_lib/handlers/invoices.ts");

const { detectSaleSendFastPath } =
  require("../../src/app/api/business-assistant/_lib/nlu/detect-wrappers.ts");

// ── Catalog stubs ─────────────────────────────────────────────────────────────

const EMPTY_CATALOG = { products: [], customers: [] };

const CATALOG = {
  products: [
    { id: "p1", name: "alfajor" },
    { id: "p2", name: "coca cola" },
  ],
  customers: [
    { id: "c1", name: "Felix" },
    { id: "c2", name: "Juan" },
  ],
};

// NluContext wrapper for detectSaleSendFastPath
function makeCtx(catalog = CATALOG) {
  return {
    catalog,
    productInfoDirectory: catalog.products.map((p) => ({ name: p.name })),
    invoiceDirectory: [],
    purchaseRequestDirectory: [],
    actorRole: "employee",
    businessId: "b1",
    employeeId: "e1",
  };
}

// ── Stock query tests (verify existing regressions still pass) ─────────────

test("stock: 'dame el stock' → stock_query or summary (not null)", () => {
  const r = detectStockSummaryFastPath("dame el stock") || detectStockQueryFastPath("dame el stock");
  assert.ok(r !== null && r !== false, "should detect stock intent");
});

test("stock: 'decime el inventario' → summary (contains inventario)", () => {
  const r = detectStockSummaryFastPath("decime el inventario");
  assert.ok(r === true || r !== false, "inventario should match summary");
});

test("stock: 'lista stock' → summary", () => {
  const r = detectStockSummaryFastPath("lista stock");
  assert.ok(r === true, "lista stock → summary");
});

test("stock: 'fijate el stock' → summary or query (not null)", () => {
  const r = detectStockSummaryFastPath("fijate el stock") || detectStockQueryFastPath("fijate el stock");
  assert.ok(r !== null && r !== false, "fijate el stock should detect stock intent");
});

test("stock: 'stock' alone → summary", () => {
  assert.ok(detectStockSummaryFastPath("stock") === true, "bare 'stock' → summary");
});

// ── C1 — mandale + comprobante must NOT fire sale_send ─────────────────────

test("C1: 'mandale el comprobante a Juan' → sale_send returns null (invoice bailout)", () => {
  const ctx = makeCtx();
  const r = detectSaleSendFastPath("mandale el comprobante a Juan", ctx);
  assert.equal(r, null,
    "C1 regression: 'mandale el comprobante' should bail out of sale_send (invoice reference detected)");
});

test("C1: 'mandale 4 alfajores a felix' → sale_send fires (not an invoice)", () => {
  const ctx = makeCtx();
  const r = detectSaleSendFastPath("mandale 4 alfajores a felix", ctx);
  assert.ok(r !== null, "sale product send should still work after C1 fix");
  assert.equal(r.kind, "sale_send");
});

// ── H1 — QR/mp question must NOT fire payment_link ─────────────────────────

test("H1: 'QR de cobro a Felix' → payment_link_fast_path", () => {
  const r = detectPaymentLinkFastPath("QR de cobro a Felix");
  assert.ok(r !== null, "QR de cobro is a valid command");
  assert.equal(r.kind, "payment_link_fast_path");
});

test("H1: 'cobrar mp es facil?' → null (question, not command)", () => {
  const r = detectPaymentLinkFastPath("cobrar mp es facil?");
  assert.equal(r, null,
    "H1 regression: info question should not trigger payment_link fast-path");
});

test("H1: 'cobrar con mp' (directive, no question words) → payment_link", () => {
  const r = detectPaymentLinkFastPath("cobrar con mp");
  assert.ok(r !== null, "direct cobrar command should still route to payment_link");
  assert.equal(r.kind, "payment_link_fast_path");
});

// ── H1-regression (JD Round 2) — QR_DIRECTIVE_RE clitic suffix now mandatory ─

test("H1-reg: 'como se cobra con mp?' → null (3rd person, not directive)", () => {
  const r = detectPaymentLinkFastPath("como se cobra con mp?");
  assert.equal(r, null,
    "H1-regression: 'cobra' without clitic suffix must NOT override question guard");
});

// Verifies the core of H1-regression: QR_QUESTION_RE fires AND QR_DIRECTIVE_RE
// no longer overrides it for `cobra` (no clitic). Without the fix, `cobra` in
// "como se cobra con mp?" matched QR_DIRECTIVE_RE with `?` → guard bypassed.
test("H1-reg: 'como se cobra con mp?' → null (QR_DIRECTIVE_RE no longer overrides guard for bare 'cobra')", () => {
  const r = detectPaymentLinkFastPath("como se cobra con mp?");
  assert.equal(r, null,
    "H1-regression: 'como se cobra' must not override question guard after clitic fix");
});

// Verifies cobrale (with clitic) still routes via the COBRALE+WPP branch when
// a WhatsApp signal is present — a different branch from QR_DIRECTIVE_RE.
test("H1-reg: 'cobrale 500 a felix por wpp' → payment_link (COBRALE+WPP branch preserved)", () => {
  const r = detectPaymentLinkFastPath("cobrale 500 a felix por wpp");
  assert.ok(r !== null,
    "H1-regression: 'cobrale ... por wpp' must still fire via COBRALE+WPP branch");
  assert.equal(r.kind, "payment_link_fast_path");
});

test("H1-reg: 'QR de cobro a Felix' → payment_link (QR_COBRO_RE branch, unaffected)", () => {
  const r = detectPaymentLinkFastPath("QR de cobro a Felix");
  assert.ok(r !== null, "QR de cobro branch must be unaffected by clitic change");
  assert.equal(r.kind, "payment_link_fast_path");
});

// ── H2 — movimiento ambiguous: cash vs stock ────────────────────────────────

test("H2: 'anula el movimiento de caja' → target is NOT stock", () => {
  const r = looksLikeUndoRequest("anulá el movimiento de caja");
  // After H2 fix: bare "movimiento de caja" lacks stock qualifier → falls
  // through to the default "sale" target (not "stock").
  assert.ok(r !== null, "should detect an undo intent");
  assert.notEqual(r.target, "stock",
    "H2 regression: 'movimiento de caja' must NOT resolve to stock target");
});

test("H2: 'deshacer el movimiento de stock' → target is stock", () => {
  const r = looksLikeUndoRequest("deshacer el movimiento de stock");
  assert.ok(r !== null, "should detect undo intent");
  assert.equal(r.target, "stock",
    "H2: 'movimiento de stock' has explicit stock qualifier → target must be stock");
});

// ── M1 — HACELE_VENTA_RE must not fire on queries ──────────────────────────

// M-B fix (JD Round 2, 2026-05-28): replaced vacuous `r !== null || true` with
// a real regex-level assertion. HACELE_VENTA_RE is now exported so the pattern
// gate can be tested independently of catalog resolution.
test("M1: HACELE_VENTA_RE matches directive 'hacele una venta a Juan'", () => {
  // normalizeForMatching strips accents and lowercases — simulate that here.
  const normalized = "hacele una venta a juan de 1 alfajor";
  assert.ok(
    HACELE_VENTA_RE.test(normalized),
    "M1: HACELE_VENTA_RE must match directive form 'hacele una venta a'"
  );
});

test("M1: HACELE_VENTA_RE does NOT match query 'hacele un resumen de la venta'", () => {
  const normalized = "hacele un resumen de la venta";
  assert.ok(
    !HACELE_VENTA_RE.test(normalized),
    "M1: HACELE_VENTA_RE must not match query form without directional preposition after 'venta'"
  );
});

test("M1: 'hacele un resumen de la venta' → NOT sale_create", () => {
  const r = detectSaleCreateFastPath("hacele un resumen de la venta", CATALOG);
  assert.equal(r, null,
    "M1 regression: 'resumen de la venta' is a query, not a sale directive");
});

// ── M3 — DAR_DE_ALTA_RE valid forms only ───────────────────────────────────

test("M3: 'dar de alta un proveedor' → create_supplier", () => {
  const r = looksLikeCreateSupplier("dar de alta un proveedor");
  assert.ok(r === true, "M3: 'dar de alta proveedor' must fire create_supplier");
});

test("M3: 'dor de alta un proveedor' → NOT create_supplier (typo)", () => {
  const r = looksLikeCreateSupplier("dor de alta un proveedor");
  assert.ok(r === false || r === undefined || !r,
    "M3 regression: 'dor de alta' is a typo and must not fire create_supplier");
});

// ── M4 — payroll blocks invoice detection ──────────────────────────────────

test("M4: 'mostrame el recibo' → hasInvoiceReference=true (valid invoice noun)", () => {
  // normalizeForMatching("mostrame el recibo") → "mostrame el recibo"
  const normalized = "mostrame el recibo";
  assert.ok(hasInvoiceReference(normalized) === true,
    "M4: bare 'recibo' without payroll context should be detected as invoice reference");
});

test("M4: 'mostrame el recibo de sueldo de Juan' → hasInvoiceReference=false (payroll)", () => {
  const normalized = "mostrame el recibo de sueldo de juan";
  assert.ok(hasInvoiceReference(normalized) === false,
    "M4 regression: 'recibo de sueldo' must NOT be detected as invoice reference");
});

test("M4: looksLikeInvoiceLookupRequest — 'mostrame el recibo' → true", () => {
  const r = looksLikeInvoiceLookupRequest("mostrame el recibo");
  assert.ok(r === true, "valid invoice lookup should still work");
});

test("M4: looksLikeInvoiceLookupRequest — 'mostrame el recibo de sueldo de Juan' → false", () => {
  const r = looksLikeInvoiceLookupRequest("mostrame el recibo de sueldo de Juan");
  assert.ok(r === false,
    "M4 regression: payroll recibo must not match invoice lookup");
});
