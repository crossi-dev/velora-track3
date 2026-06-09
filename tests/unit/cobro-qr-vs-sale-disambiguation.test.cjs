// Regression tests for the phone-number-as-amount bug (smoke 2026-05-25).
//
// Root cause: when a sale command contained a customer phone number,
// the cobro_qr detector captured the phone digits as the monto — producing
// a "cobro QR de $2.612.339.930". Two layers of defense are tested:
//
//   Layer A — sale verb guard: looksLikeCobroQrIntent returns null when the
//     text contains a sale verb (vendi/vende/etc.), regardless of phone number.
//
//   Layer B — phone digit exclusion: numbers with 10+ digits or preceded by
//     a phone signal word (telefono, tel, cel, wpp, etc.) are not considered
//     amount candidates.
//
// Both layers are tested via looksLikeCobroQrIntent directly (unit) AND via
// detectDeterministicIntent (integration) to cover the full pipeline.

"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  looksLikeCobroQrIntent,
} = require("../../src/app/api/business-assistant/_lib/handlers/cobro-qr-intent.ts");

const { detectDeterministicIntent } = require(
  "../../src/app/api/business-assistant/_lib/nlu/detect.ts"
);

// ── Shared fixtures ───────────────────────────────────────────────────────────

const CUSTOMERS_CARLOS = [{ id: "c1", name: "Carlos Rossi" }];
const CUSTOMERS_JUAN = [{ id: "c2", name: "Juan" }];
const NO_CUSTOMERS = [];

// Context for detectDeterministicIntent with empty product catalog.
// When catalog is empty, sale_create fast path returns null and cobro_qr
// becomes the only fast-path candidate — exactly the worst-case scenario
// where the phone-number bug would fire.
const ctxEmpty = {
  catalog: { products: [], customers: CUSTOMERS_CARLOS },
  productInfoDirectory: [],
  invoiceDirectory: [],
  purchaseRequestDirectory: [],
};

// ── Layer A: sale verb guard (looksLikeCobroQrIntent unit) ───────────────────

test("sale-verb guard: 'vendí 1 alfajor a Carlos Rossi telefono 1100000000' → null (sale verb wins)", () => {
  const r = looksLikeCobroQrIntent(
    "vendí 1 alfajor a Carlos Rossi telefono 1100000000",
    CUSTOMERS_CARLOS,
  );
  assert.equal(r, null, "sale verb must block cobro_qr even with phone number present");
});

test("sale-verb guard: 'vende 2 cocas a Juan tel 1123456789' → null", () => {
  const r = looksLikeCobroQrIntent(
    "vende 2 cocas a Juan tel 1123456789",
    CUSTOMERS_JUAN,
  );
  assert.equal(r, null);
});

test("sale-verb guard: 'vender 3 alfajores a Carlos 1100000000' → null", () => {
  const r = looksLikeCobroQrIntent(
    "vender 3 alfajores a Carlos 1100000000",
    CUSTOMERS_CARLOS,
  );
  assert.equal(r, null);
});

// ── Layer B: phone digit exclusion (looksLikeCobroQrIntent unit) ─────────────

test("phone-digit-exclusion: 'cobro QR telefono 1100000000' → null (no valid amount left)", () => {
  // Only number is the phone — no valid amount remains after exclusion.
  const r = looksLikeCobroQrIntent("cobro QR telefono 1100000000", NO_CUSTOMERS);
  assert.equal(r, null, "all numbers are phone-like; no monto should be extracted");
});

test("phone-digit-exclusion: 'cobro 5000 a Juan tel 1123456789' → monto=5000 (phone excluded)", () => {
  // 5000 is a valid price; 1123456789 (10 digits) is excluded as phone.
  const r = looksLikeCobroQrIntent("cobro 5000 a Juan tel 1123456789", CUSTOMERS_JUAN);
  assert.ok(r, "should detect cobro_qr with 5000");
  assert.equal(r.monto, 5000, "phone number must not override valid monto");
  assert.equal(r.metodo, "qr");
});

test("phone-digit-exclusion: 'cobro alias 3500 numero 1100000000' → monto=3500 (phone excluded)", () => {
  // 3500 valid; 1100000000 (10 digits) excluded.
  const r = looksLikeCobroQrIntent("cobro alias 3500 numero 1100000000", NO_CUSTOMERS);
  assert.ok(r);
  assert.equal(r.monto, 3500);
  assert.equal(r.metodo, "alias");
});

test("phone-digit-exclusion: bare 10-digit number in cobro phrase → null", () => {
  // No valid amount after stripping 10-digit phone — detector must bail.
  const r = looksLikeCobroQrIntent("cobro 1100000000", NO_CUSTOMERS);
  assert.equal(r, null, "10-digit number alone must not be treated as a price");
});

// ── Happy path: valid cobro commands still work ───────────────────────────────

test("happy-path: 'cobrale 5000 a Juan' → null (sale_send owns it, no alias)", () => {
  const r = looksLikeCobroQrIntent("cobrale 5000 a Juan", CUSTOMERS_JUAN);
  assert.equal(r, null);
});

test("happy-path: 'cobro 5000' → cobro_qr, monto=5000", () => {
  const r = looksLikeCobroQrIntent("cobro 5000", NO_CUSTOMERS);
  assert.ok(r);
  assert.equal(r.monto, 5000);
  assert.equal(r.metodo, "qr");
});

test("happy-path: 'cobrale 2500 a Juan por transferencia' → alias, monto=2500", () => {
  const r = looksLikeCobroQrIntent("cobrale 2500 a Juan por transferencia", CUSTOMERS_JUAN);
  assert.ok(r);
  assert.equal(r.monto, 2500);
  assert.equal(r.metodo, "alias");
});

test("happy-path: 'cobro 5000 a Juan' (no customer in phone context) → qr, monto=5000", () => {
  const r = looksLikeCobroQrIntent("cobro 5000 a Juan", CUSTOMERS_JUAN);
  assert.ok(r);
  assert.equal(r.monto, 5000);
  assert.equal(r.matchedCustomerId, "c2");
});

// ── Integration: full pipeline via detectDeterministicIntent ─────────────────

test("pipeline: 'vendí 1 alfajor a Carlos Rossi telefono 1100000000 con envío a Olascoaga 1959 Mendoza por mercado pago' → NOT cobro_qr", () => {
  // This is the exact smoke-2026-05-25 input that produced a $2.612.339.930 cobro QR.
  // Expected: either sale_create / sale_send (if catalog resolves) or null (falls to LLM).
  // Must NEVER be cobro_qr.
  const r = detectDeterministicIntent(
    "vendí 1 alfajor a Carlos Rossi telefono 1100000000 con envío a Olascoaga 1959 Mendoza por mercado pago",
    ctxEmpty,
  );
  assert.notEqual(r?.kind, "cobro_qr", "sale verb must prevent cobro_qr routing");
});

test("pipeline: 'cobro 5000' → cobro_qr (happy path unchanged)", () => {
  const r = detectDeterministicIntent("cobro 5000", ctxEmpty);
  assert.equal(r?.kind, "cobro_qr");
  assert.equal(r?.monto, 5000);
});

test("pipeline: 'cobrale 2500 a Carlos Rossi por transferencia' → cobro_qr alias", () => {
  const r = detectDeterministicIntent("cobrale 2500 a Carlos Rossi por transferencia", ctxEmpty);
  assert.equal(r?.kind, "cobro_qr");
  assert.equal(r?.metodo, "alias");
  assert.equal(r?.monto, 2500);
});

test("pipeline: phone in format 11 1234 5678 with sale verb → NOT cobro_qr", () => {
  // AR phone with spaces between segments — still a sale command.
  const r = detectDeterministicIntent(
    "vendí 1 alfajor a Juan 11 1234 5678",
    ctxEmpty,
  );
  assert.notEqual(r?.kind, "cobro_qr", "AR phone with spaces must not become cobro_qr monto");
});
