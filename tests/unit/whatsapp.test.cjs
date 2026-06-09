const assert = require("node:assert/strict");
const test = require("node:test");

const { toUserVisibleWhatsAppErrorMessage } = require("../../src/lib/whatsapp.ts");
const { appendPdfToWhatsAppMessage } = require("../../src/app/api/_lib/whatsapp-pdf-message.ts");

test("toUserVisibleWhatsAppErrorMessage traduce 'Falta configurar WHATSAPP_ACCESS_TOKEN' a mensaje user-friendly", () => {
  const message = toUserVisibleWhatsAppErrorMessage(
    new Error("Falta configurar WHATSAPP_ACCESS_TOKEN."),
    "fallback"
  );
  // No exponer nombres de env vars al usuario — el mensaje debe ser claro
  // sobre la naturaleza del problema (no está configurado) sin pedir que el
  // dueño "configure el token" (no es algo que él pueda hacer).
  assert.equal(message, "El envío por WhatsApp no está configurado en este momento.");
});

test("toUserVisibleWhatsAppErrorMessage traduce 'Falta configurar WHATSAPP_PHONE_NUMBER_ID' al mismo mensaje", () => {
  const message = toUserVisibleWhatsAppErrorMessage(
    new Error("Falta configurar WHATSAPP_PHONE_NUMBER_ID."),
    "fallback"
  );
  assert.equal(message, "El envío por WhatsApp no está configurado en este momento.");
});

test("toUserVisibleWhatsAppErrorMessage traduce 'Falta configurar' para Twilio fallback también", () => {
  // Twilio tira 'Falta configurar TWILIO_ACCOUNT_SID' / TWILIO_AUTH_TOKEN
  // cuando Meta no está y se intenta el fallback.
  const message = toUserVisibleWhatsAppErrorMessage(
    new Error("Falta configurar TWILIO_ACCOUNT_SID."),
    "fallback"
  );
  assert.equal(message, "El envío por WhatsApp no está configurado en este momento.");
});

test("toUserVisibleWhatsAppErrorMessage preserva 'El teléfono...' (mensaje ya user-facing con contexto)", () => {
  const message = toUserVisibleWhatsAppErrorMessage(
    new Error("El teléfono debe contener al menos un dígito."),
    "fallback"
  );
  assert.equal(message, "El teléfono debe contener al menos un dígito.");
});

test("toUserVisibleWhatsAppErrorMessage preserva 'La solicitud...' (timeout)", () => {
  const message = toUserVisibleWhatsAppErrorMessage(
    new Error("La solicitud a WhatsApp venció después de 15 segundos."),
    "fallback"
  );
  assert.equal(message, "La solicitud a WhatsApp venció después de 15 segundos.");
});

test("toUserVisibleWhatsAppErrorMessage usa fallback para errores remotos ruidosos", () => {
  const message = toUserVisibleWhatsAppErrorMessage(
    new Error("No se pudo enviar el mensaje por WhatsApp (Meta 400 Bad Request): detalles internos"),
    "fallback"
  );

  assert.equal(message, "fallback");
});

test("appendPdfToWhatsAppMessage agrega link y mediaUrl cuando hay PDF firmado", () => {
  const payload = appendPdfToWhatsAppMessage("Factura FC-0001-00001234", {
    url: "https://example.com/api/invoices/invoice-1/pdf?token=abc",
  });

  assert.equal(
    payload.text,
    "Factura FC-0001-00001234"
  );
  assert.equal(payload.mediaUrl, "https://example.com/api/invoices/invoice-1/pdf?token=abc");
});

test("appendPdfToWhatsAppMessage no inventa mediaUrl cuando no hay PDF", () => {
  const payload = appendPdfToWhatsAppMessage("Factura FC-0001-00001234", null);

  assert.equal(payload.text, "Factura FC-0001-00001234");
  assert.equal(payload.mediaUrl, undefined);
});
