const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildSaleConfirmChatMessage,
  getSaleDocumentLabel,
  shouldLoadBusinessAfterSaleConfirm,
} = require("../../src/app/dashboard/lib/sale-confirm-chat.ts");

test("buildSaleConfirmChatMessage arma salida base para venta confirmada", () => {
  const message = buildSaleConfirmChatMessage({
    customerName: "Carlos",
    invoiceNumber: "FC-0001-00001234",
  });

  assert.equal(
    message,
    "Venta a Carlos. Factura: FC-0001-00001234."
  );
});

test("buildSaleConfirmChatMessage agrega confirmación de WhatsApp cuando salió bien", () => {
  const message = buildSaleConfirmChatMessage({
    customerName: "Carlos",
    invoiceNumber: "FC-0001-00001234",
    whatsappResult: {
      ok: true,
      message: "Factura FC-0001-00001234 enviada a +5491112345678.",
    },
  });

  assert.equal(
    message,
    "Venta a Carlos. Factura FC-0001-00001234 enviado por WhatsApp."
  );
});

test("buildSaleConfirmChatMessage usa Consumidor Final si no hay cliente", () => {
  const message = buildSaleConfirmChatMessage({});

  assert.equal(message, "Venta a Consumidor Final.");
});

test("buildSaleConfirmChatMessage muestra error de WhatsApp cuando falla el envío", () => {
  const message = buildSaleConfirmChatMessage({
    customerName: "Carlos",
    invoiceNumber: "REC-0001-00000001",
    whatsappResult: {
      ok: false,
      message: "El cliente no tiene teléfono. Agregá un teléfono en Contactos primero.",
    },
  });

  assert.ok(
    message.includes("No se pudo enviar por WhatsApp"),
    `Expected WhatsApp error in message, got: ${message}`
  );
  assert.ok(
    message.includes("REC-0001-00000001"),
    `Expected invoice number in message, got: ${message}`
  );
});

test("getSaleDocumentLabel distingue factura fiscal de comprobante", () => {
  assert.equal(getSaleDocumentLabel("FC-0001-00001234"), "Factura");
  assert.equal(getSaleDocumentLabel("REC-0001-00000001"), "Comprobante");
});

test("shouldLoadBusinessAfterSaleConfirm recarga cuando el envío por WhatsApp falla", () => {
  assert.equal(
    shouldLoadBusinessAfterSaleConfirm({
      sendWhatsapp: true,
      hasInvoice: true,
      whatsappOk: false,
    }),
    true
  );
});

test("shouldLoadBusinessAfterSaleConfirm evita recarga duplicada cuando WhatsApp ya refrescó", () => {
  assert.equal(
    shouldLoadBusinessAfterSaleConfirm({
      sendWhatsapp: true,
      hasInvoice: true,
      whatsappOk: true,
    }),
    false
  );
});
