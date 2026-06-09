// Unit tests — extractShippingEntities
//
// Tests the Gemini NER wrapper with mocked @google/genai responses.
// No real LLM calls are made — the GoogleGenAI constructor and generateContent
// are stubbed at module level.
//
// Coverage matrix:
//   1. Full message (name + address + CP + city) → all 4 entities extracted
//   2. Name + CP only → name + postalCode extracted; address / city null
//   3. Name only, no CP → customerName extracted; rest null
//   4. No shipping context → returns null (all null → no entities)
//   5. Gemini returns empty string → returns null
//   6. Gemini response not valid JSON → returns null, no throw
//   7. Gemini generateContent throws → returns null, no throw
//   8. postalCode sanity check: non-numeric string not accepted as postalCode
//   9. Short input (< 3 chars) → returns null immediately, no Gemini call

"use strict";

const assert = require("node:assert/strict");
const test   = require("node:test");
const {
  setMockModule,
  clearMockModules,
  resetSourceModules,
} = require("../phase4/module-hooks.cjs");

// ── Mock helpers ─────────────────────────────────────────────────────────────

function makeGeminiMock(responseText) {
  const generateContent = async () => ({
    text: responseText,
    candidates: [],
    usageMetadata: {},
  });

  class GoogleGenAI {
    constructor() {}
    get models() {
      return { generateContent };
    }
  }

  return { GoogleGenAI, Type: buildTypeMock(), HarmCategory: {}, HarmBlockThreshold: {}, ThinkingLevel: { MINIMAL: "MINIMAL" } };
}

function makeGeminiThrowMock() {
  const generateContent = async () => { throw new Error("simulated Gemini failure"); };

  class GoogleGenAI {
    constructor() {}
    get models() { return { generateContent }; }
  }

  return { GoogleGenAI, Type: buildTypeMock(), HarmCategory: {}, HarmBlockThreshold: {}, ThinkingLevel: { MINIMAL: "MINIMAL" } };
}

function buildTypeMock() {
  return {
    OBJECT:  "OBJECT",
    STRING:  "STRING",
    BOOLEAN: "BOOLEAN",
    NUMBER:  "NUMBER",
    ARRAY:   "ARRAY",
  };
}

function loadExtractor(geminiMock) {
  resetSourceModules();
  clearMockModules();
  setMockModule("server-only", {});
  setMockModule("@google/genai", geminiMock);
  setMockModule("@/lib/gemini-models", {
    GeminiModels: { SUB_AGENT: "gemini-3.5-flash" },
  });
  setMockModule("@/lib/cloud-logger", { cloudLog: () => {} });
  const { extractShippingEntities } = require("../../src/lib/adk/tools/extract-shipping-entities.ts");
  return extractShippingEntities;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test("full message: all 4 entities extracted", async () => {
  const payload = JSON.stringify({
    customerName: "Juan",
    address:      "Corrientes 1234",
    postalCode:   "5500",
    city:         "Mendoza",
  });
  const fn = loadExtractor(makeGeminiMock(payload));
  const result = await fn("vendele 1 alfajor a Juan Corrientes 1234 Buenos Aires 1043");
  assert.ok(result !== null, "should return entities object");
  assert.strictEqual(result.customerName, "Juan");
  assert.strictEqual(result.address,      "Corrientes 1234");
  assert.strictEqual(result.postalCode,   "5500");
  assert.strictEqual(result.city,         "Mendoza");
});

test("name + CP only: address and city are null", async () => {
  const payload = JSON.stringify({
    customerName: "Juan",
    address:      null,
    postalCode:   "5500",
    city:         null,
  });
  const fn = loadExtractor(makeGeminiMock(payload));
  const result = await fn("enviá a Juan 5500");
  assert.ok(result !== null);
  assert.strictEqual(result.customerName, "Juan");
  assert.strictEqual(result.postalCode,   "5500");
  assert.strictEqual(result.address,      null);
  assert.strictEqual(result.city,         null);
});

test("name only: address, postalCode, city are null", async () => {
  const payload = JSON.stringify({
    customerName: "María",
    address:      null,
    postalCode:   null,
    city:         null,
  });
  const fn = loadExtractor(makeGeminiMock(payload));
  const result = await fn("enviá a María el pedido");
  assert.ok(result !== null);
  assert.strictEqual(result.customerName, "María");
  assert.strictEqual(result.postalCode,   null);
  assert.strictEqual(result.address,      null);
  assert.strictEqual(result.city,         null);
});

test("no shipping context: all null → returns null", async () => {
  const payload = JSON.stringify({
    customerName: null,
    address:      null,
    postalCode:   null,
    city:         null,
  });
  const fn = loadExtractor(makeGeminiMock(payload));
  const result = await fn("hola, ¿cuánto tengo en caja?");
  assert.strictEqual(result, null, "all-null entities should return null");
});

test("Gemini returns empty string → returns null, no throw", async () => {
  const fn = loadExtractor(makeGeminiMock(""));
  const result = await fn("enviá a Carlos Córdoba 5000");
  assert.strictEqual(result, null);
});

test("Gemini returns invalid JSON → returns null, no throw", async () => {
  const fn = loadExtractor(makeGeminiMock("not a valid json {{{"));
  const result = await fn("enviá a Carlos Córdoba 5000");
  assert.strictEqual(result, null);
});

test("Gemini generateContent throws → returns null, no throw", async () => {
  const fn = loadExtractor(makeGeminiThrowMock());
  const result = await fn("vendele algo a alguien");
  assert.strictEqual(result, null);
});

test("postalCode sanity: non-numeric string not accepted", async () => {
  const payload = JSON.stringify({
    customerName: "Carlos",
    address:      null,
    postalCode:   "CIUDAD",  // not a valid postal code
    city:         "Buenos Aires",
  });
  const fn = loadExtractor(makeGeminiMock(payload));
  const result = await fn("enviá a Carlos CIUDAD Buenos Aires");
  assert.ok(result !== null, "should still return object because name+city exist");
  assert.strictEqual(result.postalCode, null, "non-numeric postalCode must be rejected");
  assert.strictEqual(result.city,       "Buenos Aires");
});

test("short input (< 3 chars) → returns null immediately, no Gemini call", async () => {
  // If Gemini were called it would return full entities — proving it's NOT called.
  const payload = JSON.stringify({ customerName: "X", address: null, postalCode: null, city: null });
  const fn = loadExtractor(makeGeminiMock(payload));
  const result = await fn("hi");
  assert.strictEqual(result, null, "short input should short-circuit before Gemini");
});

test("whitespace-trimming: fields are trimmed", async () => {
  const payload = JSON.stringify({
    customerName: "  Lucas  ",
    address:      "  Av. Corrientes 123  ",
    postalCode:   "1043",
    city:         "  Buenos Aires  ",
  });
  const fn = loadExtractor(makeGeminiMock(payload));
  const result = await fn("enviá a Lucas Av. Corrientes 123 Buenos Aires 1043");
  assert.ok(result !== null);
  assert.strictEqual(result.customerName, "Lucas");
  assert.strictEqual(result.address,      "Av. Corrientes 123");
  assert.strictEqual(result.city,         "Buenos Aires");
});
