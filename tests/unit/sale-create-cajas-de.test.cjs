// Tests for Gap 1 — NLU routing of "vendele X cajas de Y a Z con envío, mandale link de pago".
//
// Root cause (original): the demo trigger was being swallowed by detectPaymentLinkFastPath
// (label "3z") because it contains "link de pago". A SALE_VERB_WITH_LINK_RE guard was added
// to let sale_send own the turn — but that was wrong: sale_send only returns a client-side
// register_sale modal action and never generates a payment link or quotes shipping.
//
// Correct routing (2026-05-27): "vendele 3 cajas de alfajor a Juan con envío,
// mandale link de pago" → payment_link_fast_path → executePaymentLinkFastPath
// → Payments Agent → create_payment_link → registerSaleWithPaymentLinkUseCase
// (Sale + Invoice + PaymentIntent atomic) + Andreani shipping quote. This is the
// only path that both registers the sale AND generates the WhatsApp payment link.
//
// Covers:
//   T1 — canonical demo: "vendele 3 cajas de alfajor a Juan con envio, mandale link de pago"
//          → kind=payment_link_fast_path (not sale_send)
//   T2 — "cajas de" only, no send: "vendele 3 cajas de alfajor a Juan"
//          → kind=sale_create, qty=3, product matched
//   T3 — standalone "link de pago para X" (no sale verb) → still payment_link_fast_path
//   T4 — "paquetes de" unit noun → qty=2, product matched
//   T5 — "unidades de" unit noun → qty=5, product matched
//   T6 — voseo variant "vendé 3 cajas de alfajor a Juan con envío, mandale link de pago"
//          → kind=payment_link_fast_path

const assert = require("node:assert/strict");
const test = require("node:test");

const { detectDeterministicIntent } = require("../../src/app/api/business-assistant/_lib/nlu/detect.ts");

// ── Fixtures ─────────────────────────────────────────────────────────────────

const PRODUCTS = [
  { id: "prod-001", name: "Alfajor" },
  { id: "prod-002", name: "Coca Cola" },
];

const CUSTOMERS = [
  { id: "cli-001", name: "Juan García" },
];

function makeCtx(actorRole = "owner") {
  return {
    catalog: { products: PRODUCTS, customers: CUSTOMERS },
    productInfoDirectory: PRODUCTS.map((p) => ({ name: p.name })),
    invoiceDirectory: [],
    purchaseRequestDirectory: [],
    actorRole,
    recentHistory: [],
  };
}

// ── T1: canonical demo trigger ────────────────────────────────────────────────

test("T1: 'vendele 3 cajas de alfajor a Juan con envio, mandale link de pago' → payment_link_fast_path", () => {
  const result = detectDeterministicIntent(
    "vendele 3 cajas de alfajor a Juan con envio, mandale link de pago",
    makeCtx(),
  );
  assert.ok(result, "must return a result");
  assert.equal(result.kind, "payment_link_fast_path",
    `expected payment_link_fast_path (Payments Agent path with sale + shipping), got ${result.kind}`);
});

// ── T2: "cajas de" no send → sale_create ─────────────────────────────────────

test("T2: 'vendele 3 cajas de alfajor a Juan' → sale_create, qty=3", () => {
  const result = detectDeterministicIntent(
    "vendele 3 cajas de alfajor a Juan",
    makeCtx(),
  );
  assert.ok(result, "must return a result");
  assert.equal(result.kind, "sale_create", `expected sale_create, got ${result.kind}`);
  assert.equal(result.matchedProductId, "prod-001");
  assert.equal(result.qty, 3);
});

// ── T3: standalone "link de pago" (no sale verb) → still payment_link ────────

test("T3: standalone 'link de pago para Juan' (no sale verb) → payment_link_fast_path", () => {
  const result = detectDeterministicIntent(
    "link de pago para Juan por 500",
    makeCtx(),
  );
  assert.ok(result, "must return a result");
  assert.equal(result.kind, "payment_link_fast_path",
    `standalone link de pago must stay as payment_link_fast_path, got ${result.kind}`);
});

// ── T4: "paquetes de" unit noun ───────────────────────────────────────────────

test("T4: 'vendi 2 paquetes de coca cola a Juan' → sale_create, qty=2", () => {
  const result = detectDeterministicIntent(
    "vendi 2 paquetes de coca cola a Juan",
    makeCtx(),
  );
  assert.ok(result, "must return a result");
  assert.equal(result.kind, "sale_create");
  assert.equal(result.matchedProductId, "prod-002", "must match coca cola");
  assert.equal(result.qty, 2);
});

// ── T5: "unidades de" unit noun ───────────────────────────────────────────────

test("T5: 'vendele 5 unidades de alfajor a Juan' → sale_create, qty=5", () => {
  const result = detectDeterministicIntent(
    "vendele 5 unidades de alfajor a Juan",
    makeCtx(),
  );
  assert.ok(result, "must return a result");
  assert.equal(result.kind, "sale_create");
  assert.equal(result.matchedProductId, "prod-001");
  assert.equal(result.qty, 5);
});

// ── T6: voseo "vendé" (becomes "vende" after accent-strip) ───────────────────

test("T6: voseo 'vendé 3 cajas de alfajor a Juan con envío, mandale link de pago' → payment_link_fast_path", () => {
  // "vendé" → normalizeForMatching → "vende".
  // Juan García in catalog matches "Juan" after accent normalization.
  // Routing: payment_link_fast_path owns "link de pago" regardless of sale verb prefix.
  const result = detectDeterministicIntent(
    "vendé 3 cajas de alfajor a Juan con envío, mandale link de pago",
    makeCtx(),
  );
  assert.ok(result, "must return a result");
  assert.equal(result.kind, "payment_link_fast_path",
    `expected payment_link_fast_path, got ${result.kind}`);
});
