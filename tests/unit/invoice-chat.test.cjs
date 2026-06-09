const assert = require("node:assert/strict");
const test = require("node:test");

const { buildInvoiceDownloadMessage } = require("../../src/app/dashboard/lib/invoice-chat.ts");

test("buildInvoiceDownloadMessage arma el mensaje de descarga", () => {
  assert.equal(
    buildInvoiceDownloadMessage("FC-0001-00001234"),
    "Descargando factura FC-0001-00001234."
  );
});
