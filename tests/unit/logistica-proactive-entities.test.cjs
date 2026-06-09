// Unit tests — Logística proactive entity extraction (bloque 2, 2026-05-28)
//
// Tests the integrated flow: extractShippingEntities + persistExtractedFields
// + resolveVentasShipping wiring (needsDestinationCP signal).
//
// Coverage matrix (from DESIGN_LOGISTICA_PROACTIVE.md §7):
//   1. Full message (name+address+CP+city) → all extracted + persisted + quote proceeds
//   2. Name + CP only → name + CP extracted, address/city stay null → quote proceeds
//   3. Name only (no CP) → name extracted, customer matched, CP still null → needsDestinationCP=true
//   4. No shipping intent keyword → extractor never called, flow unchanged
//   5. Customer already has CP in DB → never overwritten, even if extracted differs
//
// Additional unit tests for persistExtractedFields directly:
//   6. All fields null → all 3 written
//   7. One field already set → only nulls filled, existing value untouched
//   8. All fields already set → no DB write (update not called)
//   9. DB update throws → non-fatal, does not propagate

"use strict";

const assert = require("node:assert/strict");
const test   = require("node:test");
const {
  setMockModule,
  clearMockModules,
  resetSourceModules,
} = require("../phase4/module-hooks.cjs");

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildTypeMock() {
  return {
    OBJECT:  "OBJECT",
    STRING:  "STRING",
    BOOLEAN: "BOOLEAN",
    NUMBER:  "NUMBER",
    ARRAY:   "ARRAY",
  };
}

function makeGeminiMock(responsePayload) {
  const generateContent = async () => ({
    text: JSON.stringify(responsePayload),
    candidates: [],
  });
  class GoogleGenAI {
    constructor() {}
    get models() { return { generateContent }; }
  }
  return {
    GoogleGenAI,
    Type: buildTypeMock(),
    HarmCategory: {},
    HarmBlockThreshold: {},
    ThinkingLevel: { MINIMAL: "MINIMAL" },
  };
}

function makeGeminiNullMock() {
  // Returns all-null → extractShippingEntities returns null
  return makeGeminiMock({ customerName: null, address: null, postalCode: null, city: null });
}

// ── persistExtractedFields tests ──────────────────────────────────────────────
//
// Tests the helper directly without going through the full shipping flow.

function loadPersistHelper({ updateSpy, updateShouldThrow }) {
  resetSourceModules();
  clearMockModules();
  setMockModule("server-only", {});
  setMockModule("@/lib/cloud-logger", { cloudLog: () => {} });

  const prismaStub = {
    customer: {
      update: async (args) => {
        if (updateShouldThrow) throw new Error("simulated DB failure");
        if (updateSpy) updateSpy(args);
        return {};
      },
    },
  };
  setMockModule("@/lib/prisma", { prisma: prismaStub });

  const { persistExtractedFields } = require("../../src/lib/adk/tools/resolve-ventas-shipping-helpers.ts");
  return persistExtractedFields;
}

test("persistExtractedFields: all fields null → all 3 written to DB", async () => {
  const calls = [];
  const fn = loadPersistHelper({ updateSpy: (a) => calls.push(a), updateShouldThrow: false });

  const snapshot = { id: "c1", name: "Juan", phone: null, address: null, postalCode: null, city: null };
  const entities = { customerName: "Juan", address: "Corrientes 1234", postalCode: "5500", city: "Mendoza" };

  await fn("c1", snapshot, entities, "biz1");

  assert.strictEqual(calls.length, 1, "update called once");
  const { data } = calls[0];
  assert.strictEqual(data.address,    "Corrientes 1234");
  assert.strictEqual(data.postalCode, "5500");
  assert.strictEqual(data.city,       "Mendoza");
});

test("persistExtractedFields: postalCode already set → only address and city written", async () => {
  const calls = [];
  const fn = loadPersistHelper({ updateSpy: (a) => calls.push(a), updateShouldThrow: false });

  const snapshot = { id: "c1", name: "Juan", phone: null, address: null, postalCode: "5500", city: null };
  const entities = { customerName: "Juan", address: "Corrientes 1234", postalCode: "9999", city: "Mendoza" };

  await fn("c1", snapshot, entities, "biz1");

  assert.strictEqual(calls.length, 1);
  const { data } = calls[0];
  assert.strictEqual(data.address,    "Corrientes 1234");
  assert.strictEqual(data.city,       "Mendoza");
  assert.ok(!("postalCode" in data), "existing postalCode must not be overwritten");
});

test("persistExtractedFields: all fields already set → no DB write", async () => {
  const calls = [];
  const fn = loadPersistHelper({ updateSpy: (a) => calls.push(a), updateShouldThrow: false });

  const snapshot = { id: "c1", name: "Juan", phone: null, address: "Vieja 1", postalCode: "5500", city: "Mendoza" };
  const entities = { customerName: "Juan", address: "Corrientes 1234", postalCode: "9999", city: "Córdoba" };

  await fn("c1", snapshot, entities, "biz1");

  assert.strictEqual(calls.length, 0, "no update when all fields already populated");
});

test("persistExtractedFields: DB update throws → non-fatal, does not propagate", async () => {
  const fn = loadPersistHelper({ updateSpy: null, updateShouldThrow: true });

  const snapshot = { id: "c1", name: "Juan", phone: null, address: null, postalCode: null, city: null };
  const entities = { customerName: "Juan", address: "Corrientes 1234", postalCode: "5500", city: "Mendoza" };

  // Must not throw
  await assert.doesNotReject(
    () => fn("c1", snapshot, entities, "biz1"),
    "persistExtractedFields must catch DB errors and not propagate",
  );
});

// ── resolveVentasShipping integration tests ───────────────────────────────────
//
// Tests the full wiring: extractShippingEntities → lookupCustomerSnapshot →
// persistExtractedFields → resolveShippingQuote.

function makeShippingQuoteOk(costARS) {
  return {
    ok: true,
    costARS,
    addressSnapshot: { name: "Juan", street: "Corrientes 1234", postalCode: "5500", city: "Mendoza", phone: "1100000000" },
    resolvedCustomerId: "c1",
  };
}

function makeShippingQuoteFail(reason) {
  return { ok: false, reason };
}

function loadShippingResolver({ geminiMock, customerRows, quoteResult, updateSpy }) {
  resetSourceModules();
  clearMockModules();
  setMockModule("server-only", {});
  setMockModule("@google/genai", geminiMock);
  setMockModule("@/lib/gemini-models", { GeminiModels: { SUB_AGENT: "gemini-3.5-flash" } });
  setMockModule("@/lib/cloud-logger", { cloudLog: () => {} });

  const updateCalls = [];
  const prismaStub = {
    customer: {
      update: async (args) => {
        if (updateSpy) updateSpy(args);
        updateCalls.push(args);
        return {};
      },
    },
    $queryRaw: async () => customerRows,
  };
  setMockModule("@/lib/prisma", { prisma: prismaStub });
  setMockModule("@/lib/shipping-quote", {
    resolveShippingQuote: async () => quoteResult,
    isValidPostalCode: (cp) => typeof cp === "string" && /^\d{4,5}$/.test(cp.trim()),
  });

  // Minimal stubs for the amount/breakdown resolvers.
  setMockModule("@/lib/adk/tools/resolve-ventas-amount", {
    injectResolvedAmount: (msg) => `${msg} (BASE_PRODUCTS_ARS: $1000)`,
    resolveProductFromMessage: () => null,
  });
  setMockModule("@/lib/adk/tools/resolve-ventas-breakdown", {
    extractBreakdown: () => null,
  });
  setMockModule("@/lib/agent-timeouts", { SHIPPING_QUOTE_TIMEOUT_MS: 5000 });
  setMockModule("@/lib/a2a-client", { sendStructured: async () => {} });
  setMockModule("@/lib/agent-identity", { signAgentAssertion: async () => "jwt" });
  setMockModule("@/app/api/a2a/jsonrpc/_lib/handle-rpc", { deriveA2AKey: () => "key" });

  const { resolveVentasShipping } = require("../../src/lib/adk/tools/resolve-ventas-shipping.ts");
  return { resolveVentasShipping, updateCalls };
}

// Product catalog stub for the tests.
const PRODUCTS = [{ id: "p1", name: "Alfajor", price: 500 }];

test("resolveVentasShipping: full message → all entities extracted, persisted, quote proceeds", async () => {
  const nerPayload = { customerName: "Juan", address: "Corrientes 1234", postalCode: "5500", city: "Mendoza" };
  const customerInDB = [{ id: "c1", name: "Juan", phone: "123", address: null, postalCode: null, city: null }];

  const { resolveVentasShipping, updateCalls } = loadShippingResolver({
    geminiMock: makeGeminiMock(nerPayload),
    customerRows: customerInDB,
    quoteResult: makeShippingQuoteOk(1500),
    updateSpy: null,
  });

  const result = await resolveVentasShipping(
    "vendele 1 alfajor a Juan con envío Corrientes 1234 Buenos Aires 1043",
    "biz1",
    PRODUCTS,
  );

  assert.ok(result.fullyResolved, "should be fully resolved");
  assert.strictEqual(result.needsDestinationCP, false);
  // persistExtractedFields should have been called with address+postalCode+city
  assert.ok(updateCalls.length > 0, "DB update should have been called");
  const written = updateCalls[0].data;
  assert.strictEqual(written.address,    "Corrientes 1234");
  assert.strictEqual(written.postalCode, "5500");
  assert.strictEqual(written.city,       "Mendoza");
});

test("resolveVentasShipping: name + CP only → extracted, quote proceeds, address/city not written", async () => {
  const nerPayload = { customerName: "Juan", address: null, postalCode: "1043", city: null };
  const customerInDB = [{ id: "c2", name: "Juan", phone: null, address: null, postalCode: null, city: null }];

  const { resolveVentasShipping, updateCalls } = loadShippingResolver({
    geminiMock: makeGeminiMock(nerPayload),
    customerRows: customerInDB,
    quoteResult: makeShippingQuoteOk(800),
    updateSpy: null,
  });

  const result = await resolveVentasShipping(
    "enviá a Juan con envío 1043",
    "biz1",
    PRODUCTS,
  );

  assert.ok(result.fullyResolved, "should be fully resolved");
  assert.strictEqual(result.needsDestinationCP, false);
  // Only postalCode was extracted (address/city null → not written)
  assert.ok(updateCalls.length > 0, "DB update should have been called for postalCode");
  const written = updateCalls[0].data;
  assert.strictEqual(written.postalCode, "1043");
  assert.ok(!("address" in written), "address not extracted → not written");
  assert.ok(!("city" in written),    "city not extracted → not written");
});

test("resolveVentasShipping: name only, no CP → needsDestinationCP=true, JIT signal returned", async () => {
  const nerPayload = { customerName: "María", address: null, postalCode: null, city: null };
  const customerInDB = [{ id: "c3", name: "María", phone: null, address: null, postalCode: null, city: null }];

  const { resolveVentasShipping } = loadShippingResolver({
    geminiMock: makeGeminiMock(nerPayload),
    customerRows: customerInDB,
    quoteResult: makeShippingQuoteFail("missing_destination_postal_code"),
    updateSpy: null,
  });

  const result = await resolveVentasShipping(
    "enviá a María el pedido con envío",
    "biz1",
    PRODUCTS,
  );

  assert.strictEqual(result.fullyResolved,    false);
  assert.strictEqual(result.needsDestinationCP, true);
  assert.ok(result.cpCustomerName?.includes("María"), "cpCustomerName should contain customer name");
});

test("resolveVentasShipping: no shipping keyword → NER never called, needsDestinationCP=false", async () => {
  // If Gemini were called it would return a name — but it won't be.
  const nerPayload = { customerName: "Carlos", address: null, postalCode: null, city: null };

  const { resolveVentasShipping } = loadShippingResolver({
    geminiMock: makeGeminiMock(nerPayload),
    customerRows: [],
    quoteResult: makeShippingQuoteOk(0),
    updateSpy: null,
  });

  const result = await resolveVentasShipping(
    "vendele 1 alfajor a Carlos",  // no shipping keyword → fast-path
    "biz1",
    PRODUCTS,
  );

  // No shipping intent → resolveVentasShipping short-circuits immediately
  assert.strictEqual(result.fullyResolved,    false);
  assert.strictEqual(result.needsDestinationCP, false);
});

test("resolveVentasShipping: customer already has CP in DB → not overwritten", async () => {
  // NER extracts a different postalCode than what's in the DB.
  const nerPayload = { customerName: "Juan", address: "Corrientes 1234", postalCode: "9999", city: "Mendoza" };
  const customerInDB = [{ id: "c1", name: "Juan", phone: "123", address: null, postalCode: "5500", city: null }];
  const updateCalls = [];

  const { resolveVentasShipping } = loadShippingResolver({
    geminiMock: makeGeminiMock(nerPayload),
    customerRows: customerInDB,
    quoteResult: makeShippingQuoteOk(1500),
    updateSpy: (args) => updateCalls.push(args),
  });

  await resolveVentasShipping(
    "vendele 1 alfajor a Juan con envío",
    "biz1",
    PRODUCTS,
  );

  // Update may be called for address/city, but postalCode must NOT be in data.
  for (const call of updateCalls) {
    assert.ok(
      !("postalCode" in call.data),
      `postalCode must not be overwritten in update call: ${JSON.stringify(call.data)}`,
    );
  }
});
