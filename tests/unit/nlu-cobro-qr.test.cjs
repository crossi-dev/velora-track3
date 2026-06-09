const assert = require("node:assert/strict");
const test = require("node:test");

const { detectDeterministicIntent } = require(
  "../../src/app/api/business-assistant/_lib/nlu/detect.ts"
);

const ctx = {
  catalog: {
    products: [],
    customers: [{ id: "c1", name: "Carlos" }],
  },
  productInfoDirectory: [],
  invoiceDirectory: [],
  purchaseRequestDirectory: [],
};

test("cobro_qr — 'cobro QR 5000' detecta intent y extrae monto en modo qr", () => {
  const r = detectDeterministicIntent("cobro QR 5000", ctx);
  assert.equal(r?.kind, "cobro_qr");
  assert.equal(r.metodo, "qr");
  assert.equal(r.monto, 5000);
});

test("cobro_qr — 'cobro 5000' default a metodo qr cuando solo viene monto", () => {
  const r = detectDeterministicIntent("cobro 5000", ctx);
  assert.equal(r?.kind, "cobro_qr");
  assert.equal(r.metodo, "qr");
  assert.equal(r.monto, 5000);
});

test("cobro_qr — 'qr 5000' (alias minimal) detecta en modo qr", () => {
  const r = detectDeterministicIntent("qr 5000", ctx);
  assert.equal(r?.kind, "cobro_qr");
  assert.equal(r.metodo, "qr");
  assert.equal(r.monto, 5000);
});

test("cobro_qr — 'cobro QR 5000 a Carlos' bindea cliente del catálogo", () => {
  const r = detectDeterministicIntent("cobro QR 5000 a Carlos", ctx);
  assert.equal(r?.kind, "cobro_qr");
  assert.equal(r.metodo, "qr");
  assert.equal(r.monto, 5000);
  assert.equal(r.matchedCustomerId, "c1");
});

test("cobro_qr — null si dice 'cobro QR' sin monto", () => {
  const r = detectDeterministicIntent("cobro QR", ctx);
  assert.equal(r, null);
});

test("cobro_qr — null si pregunta '¿cómo cobro?' sin acción", () => {
  const r = detectDeterministicIntent("cómo cobro", ctx);
  assert.equal(r, null);
});
