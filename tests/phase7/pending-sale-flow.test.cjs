const test = require("node:test");
const assert = require("node:assert/strict");

const {
  inferPendingSaleFlow,
  extractQuantityFromSaleReply,
  extractPriceFromSaleReply,
  recoverPendingSaleFlow,
  resolvePendingCustomerReply,
  isSaleFlowCancelCommand,
} = require("../../src/app/dashboard/lib/pendingSaleFlow");

test("detecta aclaracion de venta pendiente por cantidad", () => {
  const flow = inferPendingSaleFlow(
    "Quiero vender una cinta métrica a Juan García",
    "¿Cuántas unidades querés vender?",
    null
  );

  assert.ok(flow);
  assert.equal(flow.missingField, "quantity");
  assert.equal(flow.saleText, "Quiero vender una cinta métrica a Juan García");
});

test("no toma un precio como respuesta válida cuando falta cantidad", () => {
  assert.equal(extractQuantityFromSaleReply("40 pesos"), null);
  assert.equal(extractQuantityFromSaleReply("2 unidades a 40 pesos"), 2);
});

test("no toma una cantidad como respuesta válida cuando falta precio", () => {
  assert.equal(extractPriceFromSaleReply("2 unidades"), null);
  assert.equal(extractPriceFromSaleReply("2 unidades a 40 pesos"), 40);
  assert.equal(extractPriceFromSaleReply("cuarenta pesos"), 40);
});

test("mantiene el pedido de cliente cuando la respuesta parece un producto", () => {
  const resolution = resolvePendingCustomerReply(
    "Cinta métrica",
    "Quiero vender una cinta métrica",
    [{ id: "c1", name: "Juan García" }],
    [{ name: "Cinta métrica" }]
  );

  assert.deepEqual(resolution, { kind: "wrong_field" });
});

test("mantiene el pedido de cliente cuando la respuesta repite el producto original", () => {
  const resolution = resolvePendingCustomerReply(
    "la cinta métrica",
    "Quiero vender una cinta métrica a un cliente",
    [{ id: "c1", name: "Juan García" }],
    [{ name: "Taladro" }]
  );

  assert.deepEqual(resolution, { kind: "wrong_field" });
});

test("detecta preguntas de precio con phrasing de cuanto cobraste", () => {
  const flow = inferPendingSaleFlow(
    "Quiero vender una cinta métrica",
    "¿A cuánto la cobraste?",
    null
  );

  assert.ok(flow);
  assert.equal(flow.missingField, "price");
});

test("recupera una venta pendiente por cantidad desde el contexto visible del asistente", () => {
  const flow = recoverPendingSaleFlow({
    saleText: "Quiero vender una cinta métrica a Juan García",
    questionContext: "sale_missing_quantity",
    answer: "Necesito la cantidad exacta para ajustar el stock.",
    inputHint: null,
  });

  assert.ok(flow);
  assert.equal(flow.missingField, "quantity");
  assert.equal(flow.saleText, "Quiero vender una cinta métrica a Juan García");
});

test("recupera una venta pendiente por precio desde missingField activo", () => {
  const flow = recoverPendingSaleFlow({
    saleText: "Quiero vender una cinta métrica a Juan García",
    questionContext: "sale_missing_price",
    answer: "Necesito el precio unitario.",
    parseMissingField: {
      productId: "p1",
      productName: "Cinta métrica",
    },
  });

  assert.ok(flow);
  assert.equal(flow.missingField, "price");
  assert.equal(flow.priceProductId, "p1");
});

test("reconoce cancelacion explicita del flujo pendiente", () => {
  assert.equal(isSaleFlowCancelCommand("cancelar la venta"), true);
  assert.equal(isSaleFlowCancelCommand("40 pesos"), false);
});
