// intent-classifier.test.cjs
//
// Unit tests for NLU Layer 2 — Gemini Flash enum classifier.
// All Vertex AI calls are mocked via Module._cache injection.
//
// Verifies:
//   1. Successful classification returns the enum string Flash returned.
//   2. Unknown / out-of-enum raw response is normalised to UNKNOWN.
//   3. Flash timeout → returns UNKNOWN with cost="fallback".
//   4. Flash API error → returns UNKNOWN with cost="fallback".
//   5. cost="flash" on success, cost="fallback" on timeout/error.
//   6. latencyMs is present and numeric in all branches.

"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const Module = require("node:module");
const path = require("node:path");

// ── Mock infrastructure ────────────────────────────────────────────────────

const GENAI_PATH = require.resolve("@google/genai");
const CLASSIFIER_PATH = path.resolve(
  __dirname,
  "../../src/lib/adk/intent-classifier.ts",
);

/**
 * Install a fake @google/genai whose `ai.models.generateContent` is controlled
 * by `mockGenerateContent`. Returns a restore function.
 */
function installGenAIMock(mockGenerateContent) {
  const fakeGenAI = {
    GoogleGenAI: class FakeGoogleGenAI {
      constructor() {}
      get models() {
        return { generateContent: mockGenerateContent };
      }
    },
    // Minimal re-exports to satisfy any other import
    HarmCategory: {},
    HarmBlockThreshold: {},
    ThinkingLevel: { MINIMAL: "NONE", LOW: "LOW", MEDIUM: "MEDIUM", HIGH: "HIGH" },
  };

  const prevGenAI = Module._cache[GENAI_PATH];
  Module._cache[GENAI_PATH] = {
    id: GENAI_PATH,
    filename: GENAI_PATH,
    loaded: true,
    exports: fakeGenAI,
  };

  // Remove the classifier from cache so it re-initialises with our fake GenAI.
  const prevClassifier = Module._cache[CLASSIFIER_PATH];
  delete Module._cache[CLASSIFIER_PATH];

  return function restore() {
    if (prevGenAI) {
      Module._cache[GENAI_PATH] = prevGenAI;
    } else {
      delete Module._cache[GENAI_PATH];
    }
    if (prevClassifier) {
      Module._cache[CLASSIFIER_PATH] = prevClassifier;
    } else {
      delete Module._cache[CLASSIFIER_PATH];
    }
  };
}

function loadClassifier() {
  return require(CLASSIFIER_PATH);
}

// ── Tests ──────────────────────────────────────────────────────────────────

test("classifier: STOCK_QUERY returned by Flash", async () => {
  const restore = installGenAIMock(async () => ({ text: "STOCK_QUERY" }));
  try {
    const { classifyIntent } = loadClassifier();
    const result = await classifyIntent("qe stock ay", { timeoutMs: 5000 });
    assert.equal(result.intent, "STOCK_QUERY");
    assert.equal(result.cost, "flash");
    assert.ok(typeof result.latencyMs === "number" && result.latencyMs >= 0);
  } finally {
    restore();
  }
});

test("classifier: REGISTER_SALE returned by Flash", async () => {
  const restore = installGenAIMock(async () => ({ text: "REGISTER_SALE" }));
  try {
    const { classifyIntent } = loadClassifier();
    const result = await classifyIntent("kiero vender un alfajor");
    assert.equal(result.intent, "REGISTER_SALE");
    assert.equal(result.cost, "flash");
  } finally {
    restore();
  }
});

test("classifier: PAYMENT_LINK returned by Flash", async () => {
  const restore = installGenAIMock(async () => ({ text: "PAYMENT_LINK" }));
  try {
    const { classifyIntent } = loadClassifier();
    const result = await classifyIntent("link de pago a felix");
    assert.equal(result.intent, "PAYMENT_LINK");
    assert.equal(result.cost, "flash");
  } finally {
    restore();
  }
});

test("classifier: out-of-enum raw value normalised to UNKNOWN (cost=flash)", async () => {
  // Flash returns something not in the enum — we still got a response, so cost="flash".
  const restore = installGenAIMock(async () => ({ text: "TOTALLY_UNKNOWN_LABEL" }));
  try {
    const { classifyIntent } = loadClassifier();
    const result = await classifyIntent("algo raro");
    assert.equal(result.intent, "UNKNOWN");
    assert.equal(result.cost, "flash");
  } finally {
    restore();
  }
});

test("classifier: empty/whitespace raw value normalised to UNKNOWN (cost=flash)", async () => {
  const restore = installGenAIMock(async () => ({ text: "   " }));
  try {
    const { classifyIntent } = loadClassifier();
    const result = await classifyIntent("...");
    assert.equal(result.intent, "UNKNOWN");
    assert.equal(result.cost, "flash");
  } finally {
    restore();
  }
});

test("classifier: timeout → UNKNOWN with cost=fallback", async () => {
  // Simulate a hanging Flash call — never resolves within the timeout.
  const restore = installGenAIMock(() => new Promise(() => {}));
  try {
    const { classifyIntent } = loadClassifier();
    const start = Date.now();
    const result = await classifyIntent("cuánto stock queda", { timeoutMs: 30 });
    const elapsed = Date.now() - start;
    assert.equal(result.intent, "UNKNOWN");
    assert.equal(result.cost, "fallback");
    assert.ok(typeof result.latencyMs === "number");
    // Should resolve promptly after the timeout fires (≤500ms margin).
    assert.ok(elapsed < 500, `expected elapsed < 500ms, got ${elapsed}ms`);
  } finally {
    restore();
  }
});

test("classifier: Flash API error → UNKNOWN with cost=fallback", async () => {
  const restore = installGenAIMock(async () => {
    throw new Error("Vertex AI returned 503");
  });
  try {
    const { classifyIntent } = loadClassifier();
    const result = await classifyIntent("algo");
    assert.equal(result.intent, "UNKNOWN");
    assert.equal(result.cost, "fallback");
    assert.ok(typeof result.latencyMs === "number");
  } finally {
    restore();
  }
});

test("classifier: latencyMs is present and numeric on success", async () => {
  const restore = installGenAIMock(async () => ({ text: "UNDO" }));
  try {
    const { classifyIntent } = loadClassifier();
    const result = await classifyIntent("deshacé la última venta");
    assert.ok("latencyMs" in result, "latencyMs must be in result");
    assert.ok(typeof result.latencyMs === "number");
    assert.ok(result.latencyMs >= 0, "latencyMs must be non-negative");
  } finally {
    restore();
  }
});

test("classifier: case-insensitive normalisation (lowercase from Flash)", async () => {
  // Some Flash outputs may be lowercase; classifier should uppercase and match.
  const restore = installGenAIMock(async () => ({ text: "stock_query" }));
  try {
    const { classifyIntent } = loadClassifier();
    const result = await classifyIntent("stock");
    assert.equal(result.intent, "STOCK_QUERY");
    assert.equal(result.cost, "flash");
  } finally {
    restore();
  }
});

test("classifier: UNKNOWN intent from Flash is accepted as-is (cost=flash)", async () => {
  const restore = installGenAIMock(async () => ({ text: "UNKNOWN" }));
  try {
    const { classifyIntent } = loadClassifier();
    const result = await classifyIntent("hola, buen día");
    assert.equal(result.intent, "UNKNOWN");
    assert.equal(result.cost, "flash");
  } finally {
    restore();
  }
});
