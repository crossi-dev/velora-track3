// Tests for cobrale + alias/transferencia fast-path detection.
// Covers the Fix-1 regression: "cobrale 5000 a juan por transferencia" must
// resolve as cobro_qr (alias), NOT fall through to sale_send or the LLM.
//
// Rules under test:
//   - cobrale + transferencia/alias keyword → cobro_qr, metodo "alias"
//   - cobrale WITHOUT alias keyword → null (sale_send owns it)
//   - cobrale + QR keyword → null (QR path does not match cobrale)

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  looksLikeCobroQrIntent,
} = require("../../src/app/api/business-assistant/_lib/handlers/cobro-qr-intent.ts");

const customers = [{ id: "c1", name: "Juan" }];

// ── cobrale + transferencia/alias → alias cobro ───────────────────────────────

test("cobrale + transferencia → cobro_qr alias", () => {
  const r = looksLikeCobroQrIntent("cobrale 5000 a juan por transferencia", customers);
  assert.ok(r, "debe detectar intent");
  assert.equal(r.metodo, "alias");
  assert.equal(r.monto, 5000);
});

test("cobrale + alias keyword → cobro_qr alias", () => {
  const r = looksLikeCobroQrIntent("cobrale 5000 alias a juan", customers);
  assert.ok(r, "debe detectar intent");
  assert.equal(r.metodo, "alias");
  assert.equal(r.monto, 5000);
});

test("cobrale + transferencia bindea cliente del catálogo", () => {
  const r = looksLikeCobroQrIntent("cobrale 5000 a juan por transferencia", customers);
  assert.ok(r);
  assert.equal(r.matchedCustomerId, "c1");
  assert.equal(r.customerName, "Juan");
});

// ── cobrale SIN keyword alias → null (pertenece a sale_send) ─────────────────

test("cobrale sin alias/transferencia → null (sale_send owns it)", () => {
  const r = looksLikeCobroQrIntent("cobrale 5000 a juan", customers);
  assert.equal(r, null);
});

test("cobrale sin alias ni monto → null", () => {
  const r = looksLikeCobroQrIntent("cobrale a juan", customers);
  assert.equal(r, null);
});

// ── cobrale + QR → null (QR path does not accept cobrale) ────────────────────

test("cobrale + QR keyword → null (QR path does not match cobrale)", () => {
  // "cobrale 5000 a juan por QR" — without explicit alias/transferencia keyword
  // the intent is ambiguous; safer to fall to LLM.
  const r = looksLikeCobroQrIntent("cobrale 5000 a juan por QR", customers);
  assert.equal(r, null);
});

// ── regression: existing plain cobro paths still work ────────────────────────

test("cobro 5000 (plain) → cobro_qr qr (unchanged)", () => {
  const r = looksLikeCobroQrIntent("cobro 5000", customers);
  assert.ok(r);
  assert.equal(r.metodo, "qr");
  assert.equal(r.monto, 5000);
});

test("transferencia 5000 → cobro_qr alias (unchanged)", () => {
  const r = looksLikeCobroQrIntent("transferencia 5000", customers);
  assert.ok(r);
  assert.equal(r.metodo, "alias");
  assert.equal(r.monto, 5000);
});

// ── A2 fix (audit): AR thousands separator must parse correctly ──────────────
// Bug: matchAll(/(\d+)/) split "5.000" into "5"+"000" → monto=5 (charged $5,
// not $5000). Fix: capture full money tokens + parseARAmount.

test("cobro 5.000 → monto 5000 (separador de miles, NO $5)", () => {
  const r = looksLikeCobroQrIntent("cobro 5.000", customers);
  assert.ok(r, "debe detectar intent");
  assert.equal(r.monto, 5000);
});

test("cobro $1.500 → monto 1500", () => {
  const r = looksLikeCobroQrIntent("cobro $1.500", customers);
  assert.ok(r);
  assert.equal(r.monto, 1500);
});

test("transferencia 12.000 → monto 12000 (separador)", () => {
  const r = looksLikeCobroQrIntent("transferencia 12.000", customers);
  assert.ok(r);
  assert.equal(r.metodo, "alias");
  assert.equal(r.monto, 12000);
});
