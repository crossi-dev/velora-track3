const assert = require("node:assert/strict");
const test = require("node:test");

const { buildPurchaseRequestDownloadMessage } = require("../../src/app/dashboard/lib/purchase-request-chat.ts");

test("buildPurchaseRequestDownloadMessage arma el mensaje de descarga", () => {
  assert.equal(
    buildPurchaseRequestDownloadMessage("SOL-0001"),
    "Descargando solicitud SOL-0001."
  );
});
