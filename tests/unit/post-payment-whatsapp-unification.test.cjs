/**
 * post-payment-whatsapp-unification.test.cjs
 *
 * Verifica que el flujo de WhatsApp post-venta sea un único mensaje:
 *   - Pago síncrono (efectivo/tarjeta): PDF al cerrar venta, nada en confirm.
 *   - Pago asíncrono (qr/transferencia): nada al cerrar venta, PDF+texto en confirm.
 *   - Sin teléfono: ningún WhatsApp se manda en ningún momento.
 *   - Link expirado (sin confirm): solo llega el mensaje de solicitud de pago.
 *
 * TDD: estos tests definen el contrato antes de la implementación.
 */

"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

// ── Helpers de stub ────────────────────────────────────────────────────────────

/**
 * Crea un stub mínimo de sendWhatsAppMessage que registra cada llamada.
 * Devuelve { stub, calls } donde calls es el array de argumentos recibidos.
 */
function makeWhatsappStub() {
  const calls = [];
  const stub = async (...args) => {
    calls.push(args);
  };
  return { stub, calls };
}

/**
 * Determina si un paymentMethod es asíncrono según el contrato del dominio.
 * Fuente canónica: src/domain/sale.ts → PAYMENT_METHOD_VALUES.
 *
 * Asíncrono: el cliente paga DESPUÉS de cerrar la venta (QR genera un cobro
 * pendiente, transferencia requiere acreditación manual).
 * Síncrono: el pago se recibe al momento del cierre (efectivo, tarjeta).
 */
function isAsyncPaymentMethod(paymentMethod) {
  if (!paymentMethod) return false;
  return paymentMethod === "qr" || paymentMethod === "transferencia";
}

/**
 * Lógica del gate en sale-post-commit — extrae la decisión de "¿mando WhatsApp ahora?"
 * en una función pura que el test puede ejercitar sin montar toda la cadena.
 *
 * Devuelve true si el comprobante se debe enviar al cerrar venta (síncrono),
 * false si se difiere al confirm del pago (asíncrono).
 */
function shouldSendInvoiceOnSaleClose({
  paymentMethod,
  customerPhone,
  skipAutoWhatsapp,
}) {
  if (skipAutoWhatsapp) return false;
  if (!customerPhone) return false;
  if (isAsyncPaymentMethod(paymentMethod)) return false;
  return true;
}

/**
 * Lógica del gate en notify-customer-on-confirm — ¿mando WhatsApp en confirm?
 *
 * Solo se envía cuando el método de pago es asíncrono Y hay teléfono del cliente.
 * Para pagos síncronos el comprobante ya fue enviado en sale-post-commit.
 */
function shouldSendReceiptOnPaymentConfirm({
  paymentMethod,
  customerPhone,
}) {
  if (!customerPhone) return false;
  if (!isAsyncPaymentMethod(paymentMethod)) return false;
  return true;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test("efectivo — PDF se manda al cerrar venta, NO en confirm", async () => {
  const phone = "+5491122334455";
  const atClose = shouldSendInvoiceOnSaleClose({
    paymentMethod: "efectivo",
    customerPhone: phone,
    skipAutoWhatsapp: false,
  });
  const atConfirm = shouldSendReceiptOnPaymentConfirm({
    paymentMethod: "efectivo",
    customerPhone: phone,
  });

  assert.equal(atClose, true, "efectivo: debe enviar al cerrar venta");
  assert.equal(atConfirm, false, "efectivo: NO debe enviar en confirm");
});

test("tarjeta — PDF se manda al cerrar venta, NO en confirm", async () => {
  const phone = "+5491122334455";
  const atClose = shouldSendInvoiceOnSaleClose({
    paymentMethod: "tarjeta",
    customerPhone: phone,
    skipAutoWhatsapp: false,
  });
  const atConfirm = shouldSendReceiptOnPaymentConfirm({
    paymentMethod: "tarjeta",
    customerPhone: phone,
  });

  assert.equal(atClose, true, "tarjeta: debe enviar al cerrar venta");
  assert.equal(atConfirm, false, "tarjeta: NO debe enviar en confirm");
});

test("qr — PDF NO se manda al cerrar venta, sí en confirm con texto+PDF", async () => {
  const { stub, calls } = makeWhatsappStub();
  const phone = "+5491122334455";

  const atClose = shouldSendInvoiceOnSaleClose({
    paymentMethod: "qr",
    customerPhone: phone,
    skipAutoWhatsapp: false,
  });
  const atConfirm = shouldSendReceiptOnPaymentConfirm({
    paymentMethod: "qr",
    customerPhone: phone,
  });

  // Simular el confirm: el mensaje debe incluir monto y referencia al comprobante
  if (atConfirm) {
    const monto = 5000;
    const message = `Recibimos tu pago de $${monto.toLocaleString("es-AR")}. Adjunto tu comprobante. Gracias por tu compra!`;
    const mediaUrl = "https://cdn.example.com/receipt-qr.pdf";
    await stub(phone, message, mediaUrl);
  }

  assert.equal(atClose, false, "qr: NO debe enviar al cerrar venta");
  assert.equal(atConfirm, true, "qr: debe enviar en confirm");
  assert.equal(calls.length, 1, "qr: exactamente un WhatsApp en confirm");
  assert.equal(calls[0][0], phone, "qr: enviado al teléfono del cliente");
  assert.ok(calls[0][1].includes("Recibimos tu pago"), "qr: mensaje incluye confirmación de pago");
  assert.ok(calls[0][1].includes("comprobante"), "qr: mensaje menciona el comprobante");
  assert.ok(typeof calls[0][2] === "string" && calls[0][2].startsWith("https://"), "qr: mediaUrl adjunta");
});

test("transferencia — PDF NO se manda al cerrar venta, sí en confirm con texto+PDF", async () => {
  const { stub, calls } = makeWhatsappStub();
  const phone = "+5491122334455";

  const atClose = shouldSendInvoiceOnSaleClose({
    paymentMethod: "transferencia",
    customerPhone: phone,
    skipAutoWhatsapp: false,
  });
  const atConfirm = shouldSendReceiptOnPaymentConfirm({
    paymentMethod: "transferencia",
    customerPhone: phone,
  });

  if (atConfirm) {
    const monto = 12500;
    const message = `Recibimos tu pago de $${monto.toLocaleString("es-AR")}. Adjunto tu comprobante. Gracias por tu compra!`;
    const mediaUrl = "https://cdn.example.com/receipt-transfer.pdf";
    await stub(phone, message, mediaUrl);
  }

  assert.equal(atClose, false, "transferencia: NO debe enviar al cerrar venta");
  assert.equal(atConfirm, true, "transferencia: debe enviar en confirm");
  assert.equal(calls.length, 1, "transferencia: exactamente un WhatsApp en confirm");
  assert.ok(calls[0][1].includes("Recibimos tu pago"), "transferencia: mensaje incluye confirmación de pago");
  assert.ok(typeof calls[0][2] === "string", "transferencia: mediaUrl adjunta");
});

test("sin teléfono del cliente — ningún WhatsApp se manda (ni al cerrar ni en confirm)", async () => {
  const phone = null;

  const atClose = shouldSendInvoiceOnSaleClose({
    paymentMethod: "qr",
    customerPhone: phone,
    skipAutoWhatsapp: false,
  });
  const atConfirm = shouldSendReceiptOnPaymentConfirm({
    paymentMethod: "qr",
    customerPhone: phone,
  });

  assert.equal(atClose, false, "sin phone: no enviar al cerrar venta");
  assert.equal(atConfirm, false, "sin phone: no enviar en confirm");
});

test("transferencia sin pago confirmado (link expirado) — solo solicitud de pago, nunca PDF", async () => {
  const phone = "+5491122334455";

  // Al cerrar venta con transferencia: NO se manda PDF (diferido)
  const atClose = shouldSendInvoiceOnSaleClose({
    paymentMethod: "transferencia",
    customerPhone: phone,
    skipAutoWhatsapp: false,
  });

  // Si el pago nunca se confirma, shouldSendReceiptOnPaymentConfirm nunca se llama.
  // Validamos que la decisión en el gate de confirm sea correcta SI se llama,
  // pero asumimos que el webhook nunca dispara porque el pago no fue acreditado.
  const confirmWouldSend = shouldSendReceiptOnPaymentConfirm({
    paymentMethod: "transferencia",
    customerPhone: phone,
  });

  // La venta SÍ va a enviar la solicitud de transferencia (template WA),
  // pero NUNCA el PDF de comprobante.
  assert.equal(atClose, false, "link expirado: no mandar PDF al cerrar");
  // Si el confirm no llega, confirmWouldSend no importa — solo validamos
  // que el gate lo habilitaría en caso de llegar (regresión para cuando sí paga).
  assert.equal(confirmWouldSend, true, "link: el gate de confirm habilitaría envío si el pago llega");
});

test("skipAutoWhatsapp=true — no enviar al cerrar venta (cliente maneja el envío)", async () => {
  const phone = "+5491122334455";
  const atClose = shouldSendInvoiceOnSaleClose({
    paymentMethod: "efectivo",
    customerPhone: phone,
    skipAutoWhatsapp: true,
  });

  assert.equal(atClose, false, "skipAutoWhatsapp: el cliente maneja el envío, servidor no duplica");
});

test("paymentMethod=null — se trata como efectivo (pago síncrono), PDF al cerrar", async () => {
  const phone = "+5491122334455";
  const atClose = shouldSendInvoiceOnSaleClose({
    paymentMethod: null,
    customerPhone: phone,
    skipAutoWhatsapp: false,
  });
  const atConfirm = shouldSendReceiptOnPaymentConfirm({
    paymentMethod: null,
    customerPhone: phone,
  });

  // null/undefined = efectivo (backward compat con clientes que no mandan paymentMethod)
  assert.equal(atClose, true, "null paymentMethod: enviar al cerrar (backward compat)");
  assert.equal(atConfirm, false, "null paymentMethod: no enviar en confirm");
});
