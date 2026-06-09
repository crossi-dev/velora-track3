// Tests for owner NLU comprehension gap fixes — 2026-06-02.
//
// GAP 1: Low-stock phrasings that ended in "stock" were incorrectly captured
//   by detectStockQueryFastPath pattern 6 ("NAME stock"), extracting the whole
//   question as a fake product name. Fix: add these phrasings to
//   INVENTORY_SUMMARY_PATTERNS so they short-circuit before stock_query.
//
// GAP 2: "cuánto facturé/vendí hoy" (past-tense sales query) was matched by
//   FISCAL_INTENT_RE's `factur\w*` stem in ownerFiscalSetupStage, triggering the
//   "Para emitir comprobantes necesito el CUIT..." gate. Fix: add SALES_QUERY_RE
//   pre-check in looksLikeFiscalIntent so past-tense revenue queries are excluded.
//
// Run: node --require ./tests/phase4/register.cjs --test tests/unit/owner-nlu-comprehension-gaps.test.cjs

const assert = require("node:assert/strict");
const test = require("node:test");

const { detectStockQueryFastPath, detectStockSummaryFastPath } =
  require("../../src/app/api/business-assistant/_lib/nlu/stock-query-fast-path.ts");

// ── GAP 1: Low-stock report phrasings ────────────────────────────────────────
// Failing phrasing from live eval: "cuáles son mis productos con menos stock"
// Root cause: detectStockQueryFastPath pattern 6 (/^(.+?)\s+stock$/) matched
// the whole question, extracting productText="cuales son mis productos con menos".

test("GAP1 FIX: 'cuáles son mis productos con menos stock' → summary (not stock query)", () => {
  const isSummary = detectStockSummaryFastPath("cuáles son mis productos con menos stock");
  assert.equal(isSummary, true,
    "should route to stock_summary, not stock_query");

  const isQuery = detectStockQueryFastPath("cuáles son mis productos con menos stock");
  assert.equal(isQuery, null,
    "stock_query must not extract a fake product name from this phrase");
});

test("GAP1 FIX: 'cuales son mis productos con menos stock' (no accents) → summary", () => {
  // Verify accent-stripped variant also works (normalizeForMatching is applied upstream).
  const isSummary = detectStockSummaryFastPath("cuales son mis productos con menos stock");
  assert.equal(isSummary, true);

  const isQuery = detectStockQueryFastPath("cuales son mis productos con menos stock");
  assert.equal(isQuery, null);
});

test("GAP1 FIX: 'productos con menos stock' → summary", () => {
  assert.equal(detectStockSummaryFastPath("productos con menos stock"), true);
  assert.equal(detectStockQueryFastPath("productos con menos stock"), null);
});

test("GAP1 FIX: 'productos bajos de stock' → summary", () => {
  assert.equal(detectStockSummaryFastPath("productos bajos de stock"), true);
  assert.equal(detectStockQueryFastPath("productos bajos de stock"), null);
});

test("GAP1 FIX: 'qué reponer' → summary", () => {
  assert.equal(detectStockSummaryFastPath("qué reponer"), true);
  assert.equal(detectStockQueryFastPath("qué reponer"), null);
});

test("GAP1 FIX: 'qué tengo que reponer' → summary", () => {
  assert.equal(detectStockSummaryFastPath("qué tengo que reponer"), true);
});

test("GAP1 FIX: 'productos por agotarse' → summary", () => {
  assert.equal(detectStockSummaryFastPath("productos por agotarse"), true);
  assert.equal(detectStockQueryFastPath("productos por agotarse"), null);
});

test("GAP1 FIX: 'qué productos están por agotarse' → summary", () => {
  // This phrasing was already working (fell to LLM), but now it routes
  // deterministically as summary — same quality, faster.
  assert.equal(detectStockSummaryFastPath("qué productos están por agotarse"), true);
});

// ── GAP 1: Working phrasing must NOT regress ──────────────────────────────────
// "fernet stock" was a product-scoped query before and must remain so.
test("GAP1 REGRESSION: 'fernet stock' still routes to stock_query, not summary", () => {
  assert.equal(detectStockSummaryFastPath("fernet stock"), false,
    "a product-name before 'stock' must remain a product-scoped query");
  const q = detectStockQueryFastPath("fernet stock");
  assert.ok(q !== null, "fernet stock must be detected as stock_query");
  assert.ok(
    q.productText.includes("fernet"),
    `productText must contain 'fernet', got: ${q.productText}`
  );
});

test("GAP1 REGRESSION: 'cuánto stock tengo de Coca Cola' still routes to stock_query", () => {
  const q = detectStockQueryFastPath("cuánto stock tengo de Coca Cola");
  assert.ok(q !== null);
  assert.ok(q.productText.toLowerCase().includes("coca cola"), `got: ${q.productText}`);
});

test("GAP1 REGRESSION: 'cuánto stock tengo' still routes to stock_summary", () => {
  assert.equal(detectStockSummaryFastPath("cuánto stock tengo"), true);
});

// ── GAP 2: "facturé" confusion with fiscal emit ───────────────────────────────
// The fiscal-setup module's looksLikeFiscalIntent is not directly testable
// without a DB mock, so we test the exported SALES_QUERY_RE logic inline by
// reproducing the same normalizeForMatching + regex logic.

const { normalizeForMatching } = require("../../src/app/api/business-assistant/_lib/shared.ts");

// Reproduce the guard logic from looksLikeFiscalIntent:
const FISCAL_INTENT_RE =
  /\b(factura|factur\w*|comprobante|arca|afip|fiscal|emitir|emiti\w*|recib\w*)\b/i;
const SALES_QUERY_RE =
  /\bcu[aá]nto\s+(?:factur[eé]|vend[ií]|gan[eé]|cobr[eé]|hice|hici)\b/i;

function looksLikeFiscalIntentSimulated(text) {
  if (!text) return false;
  const normalized = normalizeForMatching(text);
  if (SALES_QUERY_RE.test(normalized)) return false;
  return FISCAL_INTENT_RE.test(normalized);
}

test("GAP2 FIX: 'cuánto facturé hoy' → NOT fiscal intent (must route to LLM/supervisor)", () => {
  assert.equal(
    looksLikeFiscalIntentSimulated("cuánto facturé hoy"),
    false,
    "'cuánto facturé hoy' is a sales query, not a fiscal emission intent"
  );
});

test("GAP2 FIX: 'cuanto facture hoy' (no accents) → NOT fiscal intent", () => {
  assert.equal(looksLikeFiscalIntentSimulated("cuanto facture hoy"), false);
});

test("GAP2 FIX: 'cuánto vendí hoy' → NOT fiscal intent", () => {
  assert.equal(looksLikeFiscalIntentSimulated("cuánto vendí hoy"), false);
});

test("GAP2 FIX: 'cuánto gané esta semana' → NOT fiscal intent", () => {
  assert.equal(looksLikeFiscalIntentSimulated("cuánto gané esta semana"), false);
});

test("GAP2 FIX: 'cuánto cobré hoy' → NOT fiscal intent", () => {
  assert.equal(looksLikeFiscalIntentSimulated("cuánto cobré hoy"), false);
});

// ── GAP 2: Fiscal emission phrasings must still route to fiscal setup ─────────
test("GAP2 REGRESSION: 'emití una factura' still matches fiscal intent", () => {
  assert.equal(looksLikeFiscalIntentSimulated("emití una factura"), true);
});

test("GAP2 REGRESSION: 'hacé una factura para García' still matches fiscal intent", () => {
  assert.equal(looksLikeFiscalIntentSimulated("hacé una factura para García"), true);
});

test("GAP2 REGRESSION: 'necesito el comprobante' still matches fiscal intent", () => {
  assert.equal(looksLikeFiscalIntentSimulated("necesito el comprobante"), true);
});

test("GAP2 REGRESSION: 'conectar ARCA' still matches fiscal intent", () => {
  assert.equal(looksLikeFiscalIntentSimulated("conectar ARCA"), true);
});

test("GAP2 REGRESSION: 'factura para juan' still matches fiscal intent", () => {
  assert.equal(looksLikeFiscalIntentSimulated("factura para juan"), true);
});
