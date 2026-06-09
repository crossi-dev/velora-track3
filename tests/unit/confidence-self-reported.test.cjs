const assert = require("node:assert/strict");
const test = require("node:test");

const {
  assessActionConfidence,
} = require("../../src/app/api/business-assistant/_lib/confidence.ts");

const PRODUCTS = [{ id: "p1", name: "Cemento" }];
const CUSTOMERS = [{ id: "c1", name: "Juan" }];
const SUPPLIERS = [];

test("self-reported confidence above threshold → no override", () => {
  const r = assessActionConfidence(
    "register_sale",
    {
      intent: "register_sale",
      product: { name: "Cemento" },
      matchedProductId: "p1",
      confidence: 0.9,
    },
    PRODUCTS,
    CUSTOMERS,
    SUPPLIERS
  );
  assert.equal(r.needsClarification, false);
  assert.equal(r.modelSelfReported, 0.9);
});

test("self-reported confidence below 0.6 → forces clarification on destructive intent", () => {
  const r = assessActionConfidence(
    "register_sale",
    {
      intent: "register_sale",
      product: { name: "Cemento" },
      matchedProductId: "p1",
      confidence: 0.4,
    },
    PRODUCTS,
    CUSTOMERS,
    SUPPLIERS
  );
  assert.equal(r.needsClarification, true);
  assert.equal(r.intentConfidence, "low");
  assert.match(r.reason, /confidence 0\.40/);
});

test("self-reported confidence below 0.6 on 'answer' intent → does NOT force clarification", () => {
  // Trivial intents skip the gate to avoid false positives on hola/gracias.
  const r = assessActionConfidence(
    "answer",
    { intent: "answer", confidence: 0.3 },
    PRODUCTS,
    CUSTOMERS,
    SUPPLIERS
  );
  assert.equal(r.needsClarification, false);
});

test("missing confidence field → modelSelfReported null, no override", () => {
  const r = assessActionConfidence(
    "register_sale",
    { intent: "register_sale", product: { name: "Cemento" }, matchedProductId: "p1" },
    PRODUCTS,
    CUSTOMERS,
    SUPPLIERS
  );
  assert.equal(r.modelSelfReported, null);
  assert.equal(r.needsClarification, false);
});

test("self-reported confidence is clamped to [0,1]", () => {
  const tooHigh = assessActionConfidence(
    "register_sale",
    { intent: "register_sale", matchedProductId: "p1", confidence: 1.5 },
    PRODUCTS,
    CUSTOMERS,
    SUPPLIERS
  );
  assert.equal(tooHigh.modelSelfReported, 1);

  const tooLow = assessActionConfidence(
    "register_sale",
    { intent: "register_sale", matchedProductId: "p1", confidence: -0.2 },
    PRODUCTS,
    CUSTOMERS,
    SUPPLIERS
  );
  assert.equal(tooLow.modelSelfReported, 0);
});

test("non-numeric confidence (string) → ignored, modelSelfReported null", () => {
  const r = assessActionConfidence(
    "register_sale",
    { intent: "register_sale", matchedProductId: "p1", confidence: "high" },
    PRODUCTS,
    CUSTOMERS,
    SUPPLIERS
  );
  assert.equal(r.modelSelfReported, null);
  assert.equal(r.needsClarification, false);
});
