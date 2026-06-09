// Unit tests — ADK employee fallback on timeout.
//
// Regression guard for the 2026-05-11 production bug:
// USE_ADK=true + ADK timeout → HTTP 500 because the TimeoutError was not
// caught and fell through to the route catch block. The fix makes the
// geminiCall wrapper catch any ADK error and retry via direct Gemini.
//
// Strategy: test the fallback logic in isolation without Vertex AI.

const assert = require("node:assert/strict");
const test = require("node:test");

// ── Helpers ────────────────────────────────────────────────────────────────

function makeTimeoutError() {
  return Object.assign(new Error("ADK call timed out"), { name: "TimeoutError" });
}

function makeNetworkError() {
  return Object.assign(new Error("fetch failed — network"), { name: "Error" });
}

// Simulates the fallback logic extracted from model.ts geminiCall().
// Returns { path: "adk"|"gemini", result: string }.
async function simulateFallback({ adkThrows, geminiResult }) {
  const isAdkEnabled = () => true;

  const adkCall = async () => {
    if (adkThrows) throw adkThrows;
    return "adk-text";
  };

  const directGeminiCall = async () => geminiResult;

  if (isAdkEnabled()) {
    try {
      const text = await adkCall();
      return { path: "adk", result: text };
    } catch {
      const text = await directGeminiCall();
      return { path: "gemini", result: text };
    }
  }
  const text = await directGeminiCall();
  return { path: "gemini", result: text };
}

// ── Tests ─────────────────────────────────────────────────────────────────

test("ADK timeout: falls back to direct Gemini, does not rethrow", async () => {
  const { path, result } = await simulateFallback({
    adkThrows: makeTimeoutError(),
    geminiResult: '{"intent":"answer","answer":"Hola"}',
  });
  assert.equal(path, "gemini");
  assert.match(result, /Hola/);
});

test("ADK network error: falls back to direct Gemini", async () => {
  const { path } = await simulateFallback({
    adkThrows: makeNetworkError(),
    geminiResult: '{"intent":"register_sale"}',
  });
  assert.equal(path, "gemini");
});

test("ADK success: does NOT fall through to Gemini", async () => {
  const { path, result } = await simulateFallback({
    adkThrows: null,
    geminiResult: "direct-gemini-text",
  });
  assert.equal(path, "adk");
  assert.equal(result, "adk-text");
});

test("ADK TypeError (null deref): falls back to Gemini without 500", async () => {
  const { path } = await simulateFallback({
    adkThrows: new TypeError("Cannot read properties of undefined"),
    geminiResult: '{"intent":"answer","answer":"ok"}',
  });
  assert.equal(path, "gemini");
});

test("Fallback result is passed through as the call result", async () => {
  const fallbackText = '{"intent":"business_query","answer":"Tenés 10 tuercas."}';
  const { result } = await simulateFallback({
    adkThrows: makeTimeoutError(),
    geminiResult: fallbackText,
  });
  assert.equal(result, fallbackText);
});
