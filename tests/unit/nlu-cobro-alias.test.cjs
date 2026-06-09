const assert = require("node:assert/strict");
const test = require("node:test");

const { detectDeterministicIntent } = require(
  "../../src/app/api/business-assistant/_lib/nlu/detect.ts"
);

// Slice 2 del módulo Cobro QR — modo alias personal (informal). El detector
// extiende `cobro_qr` con un discriminador `metodo: "qr" | "alias"`. Aparición
// de "alias" o "transferencia" en el texto switchea a modo alias; el resto
// del flujo (extracción de monto + cliente) es idéntico al modo qr.

const ctx = {
  catalog: {
    products: [],
    customers: [{ id: "c1", name: "Carlos" }],
  },
  productInfoDirectory: [],
  invoiceDirectory: [],
  purchaseRequestDirectory: [],
};

test("cobro_alias — 'cobro alias 5000' detecta metodo alias", () => {
  const r = detectDeterministicIntent("cobro alias 5000", ctx);
  assert.equal(r?.kind, "cobro_qr");
  assert.equal(r.metodo, "alias");
  assert.equal(r.monto, 5000);
});

test("cobro_alias — orden flexible: 'cobro 5000 alias' también detecta alias", () => {
  const r = detectDeterministicIntent("cobro 5000 alias", ctx);
  assert.equal(r?.kind, "cobro_qr");
  assert.equal(r.metodo, "alias");
  assert.equal(r.monto, 5000);
});

test("cobro_alias — 'transferencia 5000' es disparador alias por sí solo", () => {
  const r = detectDeterministicIntent("transferencia 5000", ctx);
  assert.equal(r?.kind, "cobro_qr");
  assert.equal(r.metodo, "alias");
  assert.equal(r.monto, 5000);
});

test("cobro_alias — 'cobrame 5000 alias' detecta alias con verbo cobrame", () => {
  const r = detectDeterministicIntent("cobrame 5000 alias", ctx);
  assert.equal(r?.kind, "cobro_qr");
  assert.equal(r.metodo, "alias");
  assert.equal(r.monto, 5000);
});

test("cobro_alias — bindea cliente del catálogo en modo alias", () => {
  const r = detectDeterministicIntent("cobro alias 5000 a Carlos", ctx);
  assert.equal(r?.kind, "cobro_qr");
  assert.equal(r.metodo, "alias");
  assert.equal(r.monto, 5000);
  assert.equal(r.matchedCustomerId, "c1");
});

test("cobro_alias — null si falta monto en 'cobro alias'", () => {
  const r = detectDeterministicIntent("cobro alias", ctx);
  assert.equal(r, null);
});

test("cobro_alias — null si falta monto en 'transferencia'", () => {
  const r = detectDeterministicIntent("transferencia", ctx);
  assert.equal(r, null);
});

test("cobro_alias — preguntas no disparan acción ('cómo es el alias')", () => {
  const r = detectDeterministicIntent("cómo cobro alias", ctx);
  assert.equal(r, null);
});

test("cobro_alias — 'cobro QR 5000' SIN keyword alias permanece en modo qr", () => {
  // Regression: modo qr no debe contaminarse por la rama alias.
  const r = detectDeterministicIntent("cobro QR 5000", ctx);
  assert.equal(r?.kind, "cobro_qr");
  assert.equal(r.metodo, "qr");
});
