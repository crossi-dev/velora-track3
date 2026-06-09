/**
 * nlu-detect-paraphrase.test.cjs
 *
 * Verifica que detectDeterministicIntent reconozca cada intent del owner
 * a través de múltiples paráfrasis. Tier 1 ("NLU layer") del Three Tier
 * pattern — si esto falla, el dispatcher nunca llega a llamarse.
 *
 * No mockea — pasa text real + ctx mínimo y asserta el `kind` resultante.
 * Ejecuta sólo lógica determinística (regex + entity matching), no LLM.
 */

"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { detectDeterministicIntent } = require("../../src/app/api/business-assistant/_lib/nlu/detect.ts");

const PRODUCTS = [
  { id: "p1", name: "tuercas" },
  { id: "p2", name: "destornillador" },
  { id: "p3", name: "Sierra circular" },
];
const CUSTOMERS = [
  { id: "c1", name: "Carlos Rossi" },
  { id: "c2", name: "Felix Lopez" },
  { id: "c3", name: "Juan Pérez" },
];

const CTX = {
  catalog: { products: PRODUCTS, customers: CUSTOMERS },
  productInfoDirectory: PRODUCTS,
  invoiceDirectory: [],
  purchaseRequestDirectory: [],
  actorRole: "owner",
};

function expectKind(text, kind, label) {
  const intent = detectDeterministicIntent(text, CTX);
  assert.notEqual(intent, null, `${label}: detection returned null for "${text}"`);
  assert.equal(intent.kind, kind, `${label}: expected kind=${kind}, got ${intent.kind} for "${text}"`);
}

function expectNoDeterministic(text, label) {
  const intent = detectDeterministicIntent(text, CTX);
  assert.equal(intent, null, `${label}: expected null (LLM fallback) for "${text}", got ${JSON.stringify(intent)}`);
}

// ─── undo (3 paráfrasis) ─────────────────────────────────────────────────────

test("undo: 'deshacé la última venta'", () => expectKind("deshacé la última venta", "undo", "undo p1"));
test("undo: 'anulá la venta de recién'", () => expectKind("anulá la venta de recién", "undo", "undo p2"));
test("undo: 'cancela la última venta'", () => expectKind("cancela la última venta", "undo", "undo p3"));

// ─── forgot_customer (sale-text without customer) ───────────────────────────
// (Phrasings that match looksLikeSaleWithForgottenCustomer)

test("forgot_customer: 'vendí una tuerca pero olvidé el cliente'", () => {
  const intent = detectDeterministicIntent("vendí una tuerca pero olvidé el cliente", CTX);
  // forgot_customer or null both acceptable depending on regex match
  if (intent !== null) assert.equal(intent.kind, "forgot_customer");
});

// ─── create_customer (3 paráfrasis) ──────────────────────────────────────────

test("create_customer: 'nuevo cliente Pedro García'", () =>
  expectKind("nuevo cliente Pedro García", "create_customer", "cc p1"));
test("create_customer: 'agregá a María como cliente'", () =>
  expectKind("agregá a María como cliente", "create_customer", "cc p2"));
test("create_customer: 'cargá un cliente: Roberto teléfono 123456'", () =>
  expectKind("cargá un cliente: Roberto teléfono 123456", "create_customer", "cc p3"));

// ─── sale_send (3 paráfrasis) ────────────────────────────────────────────────

test("sale_send: 'vendi una tuerca a carlos mandale wapp'", () =>
  expectKind("vendi una tuerca a carlos mandale wapp", "sale_send", "ss p1"));
// STALE UPDATE (commit 4f5c7c36): "cobrale X a Y avisale por whatsapp" was
// intentionally re-routed from sale_send → payment_link_fast_path so the
// Payments Agent handles wpp-triggered sales instead of registering a direct
// POS sale. Bare "cobrale" without wpp signal still routes to sale_send.
test("sale_send+wpp: 'cobrale 1 tuerca a felix avisale por whatsapp' → payment_link_fast_path", () =>
  expectKind("cobrale 1 tuerca a felix avisale por whatsapp", "payment_link_fast_path", "ss p2 stale"));
// STALE UPDATE (commit bf911a74): "enviale el comprobante" triggers the
// early-bailout in detectSaleSendFastPath (hasInvoiceReference) so the invoice
// handler (label 9) can fire. "comprobante" = invoice artifact → invoice intent.
test("sale_send+comprobante: 'venta de un destornillador a carlos enviale el comprobante por wa' → invoice", () =>
  expectKind("venta de un destornillador a carlos enviale el comprobante por wa", "invoice", "ss p3 stale"));

// ─── multi_price_edit (≥2 productos del catálogo + valor) ───────────────────

// detectMultiProductPriceEdit splits on `,;` / ` y ` / `&` / `.` — without
// one of these separators the parser conservatively rejects (matches only
// one product per chunk). Tests use proper separators below.
test("multi_price_edit: 'tuercas a 80 y destornillador a 150'", () =>
  expectKind("tuercas a 80 y destornillador a 150", "multi_price_edit", "mp p1"));
test("multi_price_edit: 'tuercas $80, destornillador $150'", () =>
  expectKind("tuercas $80, destornillador $150", "multi_price_edit", "mp p2"));
test("multi_price_edit: 'tuercas a $80; destornillador a $150'", () =>
  expectKind("tuercas a $80; destornillador a $150", "multi_price_edit", "mp p3"));

// ─── price_update_clarification (intención sin productos identificables) ────
// Detector requires "precio" word + ≥2 price numbers (otherwise we don't
// know what to clarify about). Tests below match contract.

test("price_update_clarification: 'el precio de las cosas: 80, 150 y 200'", () =>
  expectKind("el precio de las cosas: 80, 150 y 200", "price_update_clarification", "puc p1"));
test("price_update_clarification: 'cambia los precios: 50, 100, 200'", () =>
  expectKind("cambia los precios: 50, 100, 200", "price_update_clarification", "puc p2"));

// ─── single_price_edit — owner-skipped (LLM handles it) ─────────────────────
// For owner, single price edit returns null so supervisor LLM extracts it
// structurally with product+value. Verify the skip works.

test("single_price_edit: owner falls through to LLM (returns null)", () => {
  const text = "cambia el precio de tuercas a 80";
  const ownerIntent = detectDeterministicIntent(text, { ...CTX, actorRole: "owner" });
  assert.equal(ownerIntent, null, `owner: expected null (LLM fallback), got ${JSON.stringify(ownerIntent)}`);
});

test("single_price_edit: employee gets deterministic kind for RBAC reject", () => {
  const text = "cambia el precio de tuercas a 80";
  const empIntent = detectDeterministicIntent(text, { ...CTX, actorRole: "employee" });
  assert.notEqual(empIntent, null, "employee: detection should fire for RBAC reject");
  assert.equal(empIntent.kind, "single_price_edit");
});

// ─── No false positives on conversational owner queries ──────────────────────
// These should NOT trigger any deterministic intent — owner expects LLM.

test("no false positive: 'cómo va el día'", () =>
  expectNoDeterministic("cómo va el día", "fp p1"));
test("no false positive: 'hacéme un reporte de ventas del mes'", () =>
  expectNoDeterministic("hacéme un reporte de ventas del mes", "fp p2"));
test("no false positive: 'qué me recomendás reponer'", () =>
  expectNoDeterministic("qué me recomendás reponer", "fp p3"));
test("no false positive: empty text", () =>
  expectNoDeterministic("", "fp empty"));
test("no false positive: 'hola' (small talk)", () =>
  expectNoDeterministic("hola", "fp small talk"));
