// gemini-adapter.test.ts — Unit tests for GeminiAdapter (S2).
//
// Validates:
//   1. GeminiAdapter is a valid BaseLlm (isBaseLlm type guard passes).
//   2. GeminiAdapter is a VeloraEngineAdapter.
//   3. generateContentAsync delegates 1:1 to the wrapped Gemini — same args, same yield.
//   4. connect delegates 1:1 to the wrapped Gemini — same arg, same promise.
//   5. maybeAppendUserContent delegates 1:1 to the wrapped Gemini — same arg.
//   6. GeminiAdapter.supportedModels mirrors Gemini.supportedModels.
//   7. stream flag + abortSignal are forwarded 1:1.
//
// We mock @google/adk's Gemini class because the real constructor requires
// an API key or GOOGLE_GENAI_API_KEY env var, which is unavailable in CI.
// The mock replaces Gemini with a class that stores construction params and
// exposes spyable methods — isBaseLlm still works because we extend the real
// BaseLlm for the mock.

import { describe, it, expect, vi } from "vitest";
import type { LlmRequest, LlmResponse, BaseLlmConnection } from "@google/adk";

// ── Helpers ───────────────────────────────────────────────────────────────────

function stubRequest(): LlmRequest {
  return {} as LlmRequest;
}

function stubResponse(): LlmResponse {
  return {} as LlmResponse;
}

function stubConnection(): BaseLlmConnection {
  return {} as BaseLlmConnection;
}

// ── Mock @google/adk ──────────────────────────────────────────────────────────
//
// We need isBaseLlm to work (it checks [BASE_MODEL_SYMBOL]) and BaseLlm to
// be a real base class, so we import both from the real module and only stub
// the Gemini constructor (which requires real credentials).

vi.mock("@google/adk", async (importOriginal) => {
  const real = await importOriginal<typeof import("@google/adk")>();

  // MockGemini extends real BaseLlm so isBaseLlm() returns true for instances.
  class MockGemini extends real.BaseLlm {
    static readonly supportedModels = real.Gemini.supportedModels;

    readonly generateContentAsync = vi.fn();
    readonly connect = vi.fn();
    readonly maybeAppendUserContent = vi.fn();
  }

  return {
    ...real,
    Gemini: MockGemini,
  };
});

// Import AFTER the mock is registered so the module resolution uses the mock.
const { GeminiAdapter } = await import("@/lib/adk/adapters/gemini-adapter");
const { VeloraEngineAdapter } = await import("@/lib/adk/engine-adapter");
const { isBaseLlm, Gemini } = await import("@google/adk");

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("GeminiAdapter", () => {
  it("is an instance of VeloraEngineAdapter", () => {
    const adapter = new GeminiAdapter({ model: "gemini-2.0-flash" });
    expect(adapter).toBeInstanceOf(VeloraEngineAdapter);
  });

  it("passes the ADK isBaseLlm type guard", () => {
    const adapter = new GeminiAdapter({ model: "gemini-2.0-flash" });
    expect(isBaseLlm(adapter)).toBe(true);
  });

  it("exposes the model string from the wrapped Gemini instance", () => {
    const adapter = new GeminiAdapter({ model: "gemini-2.0-flash" });
    expect(adapter.model).toBe("gemini-2.0-flash");
  });

  it("mirrors Gemini.supportedModels on the class", () => {
    expect(GeminiAdapter.supportedModels).toBe(Gemini.supportedModels);
  });

  it("delegates generateContentAsync to the wrapped Gemini — same args, same yield", async () => {
    const req = stubRequest();
    const resp = stubResponse();

    const adapter = new GeminiAdapter({ model: "gemini-2.0-flash" });
    // Access the inner Gemini mock to set up the return value.
    const inner = (adapter as unknown as { _gemini: { generateContentAsync: ReturnType<typeof vi.fn> } })._gemini;

    async function* fakeGen(): AsyncGenerator<LlmResponse, void> {
      yield resp;
    }
    inner.generateContentAsync.mockImplementation(fakeGen);

    const gen = adapter.generateContentAsync(req, false);
    const { value, done } = await gen.next();

    expect(inner.generateContentAsync).toHaveBeenCalledOnce();
    expect(inner.generateContentAsync).toHaveBeenCalledWith(req, false, undefined);
    expect(value).toBe(resp);
    expect(done).toBe(false);
  });

  it("delegates connect to the wrapped Gemini — same arg, same promise", async () => {
    const req = stubRequest();
    const conn = stubConnection();

    const adapter = new GeminiAdapter({ model: "gemini-2.0-flash" });
    const inner = (adapter as unknown as { _gemini: { connect: ReturnType<typeof vi.fn> } })._gemini;
    inner.connect.mockResolvedValue(conn);

    const result = await adapter.connect(req);

    expect(inner.connect).toHaveBeenCalledOnce();
    expect(inner.connect).toHaveBeenCalledWith(req);
    expect(result).toBe(conn);
  });

  it("delegates maybeAppendUserContent to the wrapped Gemini — same arg", () => {
    const req = stubRequest();

    const adapter = new GeminiAdapter({ model: "gemini-2.0-flash" });
    const inner = (adapter as unknown as { _gemini: { maybeAppendUserContent: ReturnType<typeof vi.fn> } })._gemini;

    adapter.maybeAppendUserContent(req);

    expect(inner.maybeAppendUserContent).toHaveBeenCalledOnce();
    expect(inner.maybeAppendUserContent).toHaveBeenCalledWith(req);
  });

  it("forwards stream=true and abortSignal through 1:1", async () => {
    const req = stubRequest();
    const resp = stubResponse();
    const signal = new AbortController().signal;

    const adapter = new GeminiAdapter({ model: "gemini-2.0-flash" });
    const inner = (adapter as unknown as { _gemini: { generateContentAsync: ReturnType<typeof vi.fn> } })._gemini;

    async function* fakeGen(): AsyncGenerator<LlmResponse, void> {
      yield resp;
    }
    inner.generateContentAsync.mockImplementation(fakeGen);

    const gen = adapter.generateContentAsync(req, true, signal);
    await gen.next();

    expect(inner.generateContentAsync).toHaveBeenCalledWith(req, true, signal);
  });
});
