"use strict";

// payment-link-send-cancel.test.cjs
//
// Unit tests for detectPaymentLinkSend and detectPaymentLinkCancel.
// These detectors match the machine-token chip values submitted when the
// owner taps the confirm/cancel chips on the payment-link review card.
//
// Chip value format changed in commit fix(nlu): store paymentIntentId in chip
// instead of the full checkout URL to stay within the 80-char Zod limit.
// Format: "enviar_link_pago|{phone}|{paymentIntentId}" (3 pipe-separated parts).

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  detectPaymentLinkSend,
  detectPaymentLinkCancel,
} = require(
  "../../src/app/api/business-assistant/_lib/nlu/payment-link-fast-path.ts"
);
const { detectDeterministicIntent } = require(
  "../../src/app/api/business-assistant/_lib/nlu/detect.ts"
);

// A sample cuid (same format as Prisma @default(cuid()) output).
const PAYMENT_INTENT_ID = "clx4k2abcdef1234567890";

// ── detectPaymentLinkSend ─────────────────────────────────────────────────────

test("detectPaymentLinkSend: parses phone and paymentIntentId from valid token", () => {
  const r = detectPaymentLinkSend(`enviar_link_pago|+5490000000000|${PAYMENT_INTENT_ID}`);
  assert.ok(r, "should detect");
  assert.equal(r.kind, "payment_link_send");
  assert.equal(r.phone, "+5490000000000");
  assert.equal(r.paymentIntentId, PAYMENT_INTENT_ID);
});

test("detectPaymentLinkSend: parses short paymentIntentId", () => {
  const r = detectPaymentLinkSend(`enviar_link_pago|+541112345678|${PAYMENT_INTENT_ID}`);
  assert.ok(r);
  assert.equal(r.phone, "+541112345678");
  assert.equal(r.paymentIntentId, PAYMENT_INTENT_ID);
});

test("detectPaymentLinkSend: returns null for cancelar_link_pago", () => {
  assert.equal(detectPaymentLinkSend("cancelar_link_pago"), null);
});

test("detectPaymentLinkSend: returns null for plain text", () => {
  assert.equal(detectPaymentLinkSend("generá un link de pago"), null);
});

test("detectPaymentLinkSend: returns null for incomplete token (missing paymentIntentId)", () => {
  assert.equal(detectPaymentLinkSend("enviar_link_pago|+541112345678"), null);
});

test("detectPaymentLinkSend: returns null for empty string", () => {
  assert.equal(detectPaymentLinkSend(""), null);
});

test("detectPaymentLinkSend: returns null for 4-part token (old URL format with pipes)", () => {
  // Old format had URL which might contain pipes — now we require exactly 3 parts.
  assert.equal(detectPaymentLinkSend("enviar_link_pago|+541112345678|https://mp.com/pay?a=1|extra"), null);
});

// ── detectPaymentLinkCancel ───────────────────────────────────────────────────

test("detectPaymentLinkCancel: matches exact token", () => {
  const r = detectPaymentLinkCancel("cancelar_link_pago");
  assert.ok(r, "should detect");
  assert.equal(r.kind, "payment_link_cancel");
});

test("detectPaymentLinkCancel: matches with surrounding whitespace", () => {
  const r = detectPaymentLinkCancel("  cancelar_link_pago  ");
  assert.ok(r);
  assert.equal(r.kind, "payment_link_cancel");
});

test("detectPaymentLinkCancel: returns null for enviar_link_pago prefix", () => {
  assert.equal(detectPaymentLinkCancel(`enviar_link_pago|+5490000000000|${PAYMENT_INTENT_ID}`), null);
});

test("detectPaymentLinkCancel: returns null for plain text", () => {
  assert.equal(detectPaymentLinkCancel("cancelar la venta"), null);
});

// ── Integration: detectDeterministicIntent routes chip tokens ─────────────────

const ownerCtx = {
  catalog: {
    products: [{ id: "p1", name: "alfajores" }],
    customers: [{ id: "c1", name: "Carlos Rossi" }],
  },
  productInfoDirectory: [{ name: "alfajores" }],
  invoiceDirectory: [],
  purchaseRequestDirectory: [],
  actorRole: "owner",
};

test("detectDeterministicIntent: enviar_link_pago token → payment_link_send (owner)", () => {
  const r = detectDeterministicIntent(
    `enviar_link_pago|+5490000000000|${PAYMENT_INTENT_ID}`,
    ownerCtx,
  );
  assert.ok(r, "should not return null");
  assert.equal(r.kind, "payment_link_send");
});

test("detectDeterministicIntent: cancelar_link_pago token → payment_link_cancel (owner)", () => {
  const r = detectDeterministicIntent("cancelar_link_pago", ownerCtx);
  assert.ok(r, "should not return null");
  assert.equal(r.kind, "payment_link_cancel");
});

test("detectDeterministicIntent: chip tokens blocked for employees", () => {
  const employeeCtx = { ...ownerCtx, actorRole: "employee" };
  const rSend = detectDeterministicIntent(
    `enviar_link_pago|+5490000000000|${PAYMENT_INTENT_ID}`,
    employeeCtx,
  );
  if (rSend) assert.notEqual(rSend.kind, "payment_link_send");

  const rCancel = detectDeterministicIntent("cancelar_link_pago", employeeCtx);
  if (rCancel) assert.notEqual(rCancel.kind, "payment_link_cancel");
});

test("detectDeterministicIntent: send token does NOT match payment_link_fast_path", () => {
  // enviar_link_pago|... should route to payment_link_send, not payment_link_fast_path
  const r = detectDeterministicIntent(
    `enviar_link_pago|+5490000000000|${PAYMENT_INTENT_ID}`,
    ownerCtx,
  );
  assert.ok(r);
  assert.notEqual(r.kind, "payment_link_fast_path");
});
