// engine-factory.test.ts — Unit tests for createEngineModel (S3).
//
// Validates:
//   1. ENGINE unset → returns a GeminiAdapter (instanceof + isBaseLlm guard).
//   2. ENGINE="gemini" → returns a GeminiAdapter.
//   3. ENGINE="bogus" → throws with a message naming the value and the supported set.
//
// The factory reads process.env.ENGINE at CALL TIME (not module-load time), so
// we can set/delete the env var between tests without module cache tricks.
//
// We mock @google/adk's Gemini constructor (same technique as gemini-adapter.test.ts)
// because the real constructor requires credentials unavailable in CI.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mock @google/adk ──────────────────────────────────────────────────────────
// Keep real BaseLlm so isBaseLlm works; only stub Gemini (needs credentials).

vi.mock("@google/adk", async (importOriginal) => {
  const real = await importOriginal<typeof import("@google/adk")>();

  class MockGemini extends real.BaseLlm {
    static readonly supportedModels = real.Gemini.supportedModels;
    readonly generateContentAsync = vi.fn();
    readonly connect = vi.fn();
    readonly maybeAppendUserContent = vi.fn();
  }

  return { ...real, Gemini: MockGemini };
});

// Import AFTER mock registration.
const { createEngineModel } = await import("@/lib/adk/engine-factory");
const { GeminiAdapter } = await import("@/lib/adk/adapters/gemini-adapter");
const { isBaseLlm } = await import("@google/adk");

// ── Helpers ───────────────────────────────────────────────────────────────────

const OPTS = { model: "gemini-2.0-flash", project: "test-project", location: "us-central1" };

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("createEngineModel", () => {
  const originalEngine = process.env.ENGINE;

  beforeEach(() => {
    delete process.env.ENGINE;
  });

  afterEach(() => {
    if (originalEngine === undefined) {
      delete process.env.ENGINE;
    } else {
      process.env.ENGINE = originalEngine;
    }
  });

  it("ENGINE unset → returns a GeminiAdapter", () => {
    const model = createEngineModel(OPTS);
    expect(model).toBeInstanceOf(GeminiAdapter);
  });

  it("ENGINE unset → passes the ADK isBaseLlm type guard", () => {
    const model = createEngineModel(OPTS);
    expect(isBaseLlm(model)).toBe(true);
  });

  it('ENGINE="gemini" → returns a GeminiAdapter', () => {
    process.env.ENGINE = "gemini";
    const model = createEngineModel(OPTS);
    expect(model).toBeInstanceOf(GeminiAdapter);
  });

  it('ENGINE="gemini" → passes the ADK isBaseLlm type guard', () => {
    process.env.ENGINE = "gemini";
    const model = createEngineModel(OPTS);
    expect(isBaseLlm(model)).toBe(true);
  });

  it('ENGINE="" (blank) → defaults to GeminiAdapter, does not throw', () => {
    // An operator who sets `ENGINE=` on Cloud Run leaves an empty string, which
    // `??` would NOT catch. Blank/whitespace must default to gemini, not crash.
    process.env.ENGINE = "";
    const model = createEngineModel(OPTS);
    expect(model).toBeInstanceOf(GeminiAdapter);
  });

  it('ENGINE="  " (whitespace) → defaults to GeminiAdapter', () => {
    process.env.ENGINE = "   ";
    const model = createEngineModel(OPTS);
    expect(model).toBeInstanceOf(GeminiAdapter);
  });

  it('ENGINE="bogus" → throws with the bad value in the message', () => {
    process.env.ENGINE = "bogus";
    expect(() => createEngineModel(OPTS)).toThrow(/bogus/);
  });

  it('ENGINE="bogus" → throws naming the supported set', () => {
    process.env.ENGINE = "bogus";
    expect(() => createEngineModel(OPTS)).toThrow(/gemini/);
  });

  it("reads ENGINE at call time, not module-load time", () => {
    // First call with ENGINE unset → GeminiAdapter.
    const first = createEngineModel(OPTS);
    expect(first).toBeInstanceOf(GeminiAdapter);

    // Set ENGINE to bogus AFTER import — factory must still throw.
    process.env.ENGINE = "bogus";
    expect(() => createEngineModel(OPTS)).toThrow();

    // Reset and confirm it returns GeminiAdapter again.
    delete process.env.ENGINE;
    const third = createEngineModel(OPTS);
    expect(third).toBeInstanceOf(GeminiAdapter);
  });
});
