const assert = require("node:assert/strict");
const test = require("node:test");

const {
  extractQuantityFromSaleReply,
  extractPriceFromSaleReply,
  isSaleFlowCancelCommand,
  looksLikeNewSaleIntent,
} = require("../../src/app/dashboard/lib/pendingSaleFlow.ts");

// ── extractQuantityFromSaleReply ──

test("extractQuantity: plain number", () => {
  assert.equal(extractQuantityFromSaleReply("5"), 5);
});

test("extractQuantity: number with units", () => {
  assert.equal(extractQuantityFromSaleReply("10 unidades"), 10);
});

test("extractQuantity: Spanish word number", () => {
  assert.equal(extractQuantityFromSaleReply("tres"), 3);
});

test("extractQuantity: empty string returns null", () => {
  assert.equal(extractQuantityFromSaleReply(""), null);
});

test("extractQuantity: price-like text without units returns null", () => {
  assert.equal(extractQuantityFromSaleReply("$500 pesos"), null);
});

// ── extractPriceFromSaleReply ──

test("extractPrice: dollar sign", () => {
  assert.equal(extractPriceFromSaleReply("$1500"), 1500);
});

test("extractPrice: word 'pesos'", () => {
  assert.equal(extractPriceFromSaleReply("1500 pesos"), 1500);
});

test("extractPrice: empty returns null", () => {
  assert.equal(extractPriceFromSaleReply(""), null);
});

test("extractPrice: unit terms without price returns null", () => {
  assert.equal(extractPriceFromSaleReply("10 unidades"), null);
});

// ── isSaleFlowCancelCommand ──

test("cancel: 'cancelar' is a cancel command", () => {
  assert.equal(isSaleFlowCancelCommand("cancelar"), true);
});

test("cancel: 'salir' is a cancel command", () => {
  assert.equal(isSaleFlowCancelCommand("salir"), true);
});

test("cancel: 'descartar' is a cancel command", () => {
  assert.equal(isSaleFlowCancelCommand("descartar"), true);
});

test("cancel: regular text is not cancel", () => {
  assert.equal(isSaleFlowCancelCommand("vendí 3 remeras"), false);
});

// ── looksLikeNewSaleIntent ──

test("saleIntent: 'vendí 3 remeras' looks like a sale", () => {
  assert.equal(looksLikeNewSaleIntent("vendí 3 remeras a Juan"), true);
});

test("saleIntent: 'cuánto vendí hoy' is a question, not a sale", () => {
  assert.equal(looksLikeNewSaleIntent("cuánto vendí hoy"), false);
});

test("saleIntent: 'qué producto se vende más' is a question", () => {
  assert.equal(looksLikeNewSaleIntent("qué producto se vende más"), false);
});

test("saleIntent: 'cómo anda la caja' is a question", () => {
  assert.equal(looksLikeNewSaleIntent("cómo anda la caja"), false);
});

test("saleIntent: 'vendele 2 bolsas a López' is a sale", () => {
  assert.equal(looksLikeNewSaleIntent("vendele 2 bolsas a López"), true);
});
