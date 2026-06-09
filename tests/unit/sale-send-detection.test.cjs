const assert = require("node:assert/strict");
const test = require("node:test");

const { containsSendKeyword } = require("../../src/lib/sale-send-detection.ts");

test("detects 'mandale wpp'", () => {
  assert.equal(containsSendKeyword("vendí 1 yerba a juan mandale wpp"), true);
});

test("detects 'whatsapp'", () => {
  assert.equal(containsSendKeyword("cobrale 500 a María, mandá whatsapp"), true);
});

test("detects 'enviale'", () => {
  assert.equal(containsSendKeyword("vendele 3 clavos a López y enviale la factura"), true);
});

test("detects uppercase", () => {
  assert.equal(containsSendKeyword("MANDALE WPP"), true);
});

test("does NOT detect unrelated sale", () => {
  assert.equal(containsSendKeyword("vendí 2 peras a carlos"), false);
});

test("does NOT detect empty", () => {
  assert.equal(containsSendKeyword(""), false);
});

test("does NOT detect partial words", () => {
  // Word boundary guards against "demanda" matching "manda"
  assert.equal(containsSendKeyword("analiza la demanda"), false);
});
