"use strict";

// payment-link-fast-path.test.cjs
//
// Verifies that the deterministic payment-link detector fires for all expected
// phrasings and does NOT fire for false positives.
//
// Also verifies that detectDeterministicIntent routes these through the
// PRIORITY_TABLE before cobro_qr and returns payment_link_fast_path.

const assert = require("node:assert/strict");
const test = require("node:test");

const { detectPaymentLinkFastPath } = require(
  "../../src/app/api/business-assistant/_lib/nlu/payment-link-fast-path.ts"
);
const { detectDeterministicIntent } = require(
  "../../src/app/api/business-assistant/_lib/nlu/detect.ts"
);
const { mightBeDeterministicIntent } = require(
  "../../src/app/api/business-assistant/_lib/nlu/hint-precheck.ts"
);

// ── detectPaymentLinkFastPath unit tests ──────────────────────────────────────

test("detects primary: 'generá un link de pago para María García'", () => {
  const r = detectPaymentLinkFastPath(
    "generá un link de pago para María García por 3 filtros de aire con envío incluido"
  );
  assert.ok(r, "should detect");
  assert.equal(r.kind, "payment_link_fast_path");
});

test("detects primary: 'link de cobro'", () => {
  const r = detectPaymentLinkFastPath("mandá un link de cobro a Juan");
  assert.ok(r);
  assert.equal(r.kind, "payment_link_fast_path");
});

test("detects primary: 'link de pago' alone", () => {
  const r = detectPaymentLinkFastPath("link de pago para Carlos");
  assert.ok(r);
  assert.equal(r.kind, "payment_link_fast_path");
});

test("detects secondary verb: 'armá un link'", () => {
  const r = detectPaymentLinkFastPath("armá un link para el pedido de Laura");
  assert.ok(r);
  assert.equal(r.kind, "payment_link_fast_path");
});

test("detects secondary verb: 'creá un link'", () => {
  const r = detectPaymentLinkFastPath("creá un link para cobrarle a Roberto");
  assert.ok(r);
  assert.equal(r.kind, "payment_link_fast_path");
});

test("detects secondary verb: 'hacéme un link'", () => {
  const r = detectPaymentLinkFastPath("hacéme un link de cobro para el pedido");
  assert.ok(r);
  assert.equal(r.kind, "payment_link_fast_path");
});

test("does NOT detect question: 'cómo genero un link de pago'", () => {
  const r = detectPaymentLinkFastPath("cómo genero un link de pago");
  assert.equal(r, null);
});

test("does NOT detect unrelated 'link'", () => {
  const r = detectPaymentLinkFastPath("mandame el link del producto en mercadolibre");
  assert.equal(r, null);
});

test("does NOT detect empty", () => {
  assert.equal(detectPaymentLinkFastPath(""), null);
  assert.equal(detectPaymentLinkFastPath("   "), null);
});

// ── hint-precheck covers "link" ────────────────────────────────────────────────

test("mightBeDeterministicIntent: 'generá un link de pago' passes pre-check", () => {
  assert.equal(
    mightBeDeterministicIntent("generá un link de pago para María"),
    true
  );
});

// ── Integration: detectDeterministicIntent routes to payment_link_fast_path ──

const ownerCtx = {
  catalog: {
    products: [{ id: "p1", name: "filtros de aire" }],
    customers: [{ id: "c1", name: "María García" }],
  },
  productInfoDirectory: [{ name: "filtros de aire" }],
  invoiceDirectory: [],
  purchaseRequestDirectory: [],
  actorRole: "owner",
};

test("detectDeterministicIntent: north-star demo phrase → payment_link_fast_path", () => {
  const r = detectDeterministicIntent(
    "generá un link de pago para María García por 3 filtros de aire con envío incluido",
    ownerCtx
  );
  assert.ok(r, "should not return null");
  assert.equal(r.kind, "payment_link_fast_path", `expected payment_link_fast_path, got ${r?.kind}`);
});

test("detectDeterministicIntent: employee ctx → no payment_link_fast_path (owner-only guard)", () => {
  const employeeCtx = { ...ownerCtx, actorRole: "employee" };
  const r = detectDeterministicIntent(
    "generá un link de pago para María García",
    employeeCtx
  );
  // Employees should not get payment_link_fast_path — the guard filters it.
  if (r) {
    assert.notEqual(r.kind, "payment_link_fast_path");
  }
});

test("detectDeterministicIntent: 'link de cobro a Juan' → payment_link_fast_path", () => {
  const r = detectDeterministicIntent("mandá un link de cobro a Juan", ownerCtx);
  assert.ok(r);
  assert.equal(r.kind, "payment_link_fast_path");
});
