const assert = require("node:assert/strict");
const test = require("node:test");

const { resolveSaleWhatsappRecipient } = require("../../src/app/dashboard/lib/sale-whatsapp-recipient.ts");

test("resolveSaleWhatsappRecipient usa el teléfono actual del cliente seleccionado", () => {
  const result = resolveSaleWhatsappRecipient(
    {
      customer: {
        id: "cust-1",
        name: "Carlos Rossi",
      },
    },
    [
      { id: "cust-1", name: "Carlos Rossi", phone: "+5491112345678" },
      { id: "cust-2", name: "Otro", phone: "+5491199999999" },
    ]
  );

  assert.deepEqual(result, {
    customerName: "Carlos Rossi",
    customerPhone: "+5491112345678",
  });
});

test("resolveSaleWhatsappRecipient cae a Consumidor Final cuando no hay cliente", () => {
  const result = resolveSaleWhatsappRecipient(null, []);

  assert.deepEqual(result, {
    customerName: "Consumidor Final",
    customerPhone: null,
  });
});
