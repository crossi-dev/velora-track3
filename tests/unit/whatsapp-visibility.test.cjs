const assert = require("node:assert/strict");
const test = require("node:test");

const {
  canSendInvoiceByWhatsapp,
} = require("../../src/app/dashboard/lib/whatsapp-visibility.ts");

test("canSendInvoiceByWhatsapp: cliente con teléfono normal → true", () => {
  assert.equal(canSendInvoiceByWhatsapp("+5491112345678"), true);
  assert.equal(canSendInvoiceByWhatsapp("1112345678"), true);
});

test("canSendInvoiceByWhatsapp: null → false (cliente sin teléfono o venta sin cliente)", () => {
  assert.equal(canSendInvoiceByWhatsapp(null), false);
});

test("canSendInvoiceByWhatsapp: undefined → false (campo ausente del payload)", () => {
  assert.equal(canSendInvoiceByWhatsapp(undefined), false);
});

test("canSendInvoiceByWhatsapp: string vacío → false", () => {
  assert.equal(canSendInvoiceByWhatsapp(""), false);
});

test("canSendInvoiceByWhatsapp: solo whitespace → false", () => {
  assert.equal(canSendInvoiceByWhatsapp("   "), false);
  assert.equal(canSendInvoiceByWhatsapp("\t\n"), false);
});

test("canSendInvoiceByWhatsapp: valor no-string → false (defensivo)", () => {
  // @ts-expect-error - testing defensive runtime behavior
  assert.equal(canSendInvoiceByWhatsapp(123456789), false);
  // @ts-expect-error
  assert.equal(canSendInvoiceByWhatsapp({ phone: "x" }), false);
});
