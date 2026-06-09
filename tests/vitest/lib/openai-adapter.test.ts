// openai-adapter.test.ts — Unit tests for OpenAIAdapter.
//
// Validates that OpenAIAdapter:
//   1. Is an instance of VeloraEngineAdapter (satisfies the engine port).
//   2. Passes the ADK isBaseLlm type guard.
//   3. Translates LlmRequest.contents → correct OpenAI messages shape.
//   4. Translates a system instruction → role:"system" prepended message.
//   5. Maps OpenAI response choices[0].message.content → LlmResponse.content.
//   6. Propagates usageMetadata when OpenAI usage is present.
//   7. Returns errorCode:"no_choices" when choices is empty.
//   8. connect() throws NotImplementedError.
//   9. Throws at construction when OPENAI_API_KEY is absent.
//  10. ENGINE="openai" → createEngineModel returns an OpenAIAdapter.
//  11. ENGINE="openai" → factory error message still names "gemini" (supported set).
//  12. Tool declarations in config.tools → OpenAI tools[] in request payload.
//  13. functionResponse Content parts → role:"tool" messages in request payload.
//  14. OpenAI tool_calls in response → LlmResponse Content with functionCall parts.
//  15. tool_calls arguments (JSON string) are parsed back to an object in LlmResponse.
//  16. Mixed request: tool declarations + prior functionResponse → correct full payload.
//
// All HTTP calls are mocked via vi.stubGlobal("fetch", ...).
// @google/adk Gemini constructor is mocked so isBaseLlm works without credentials.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { LlmRequest, LlmResponse } from "@google/adk";

// ── Mock @google/adk ──────────────────────────────────────────────────────────
// Keep real BaseLlm (needed for isBaseLlm type guard + VeloraEngineAdapter base).
// Stub Gemini (requires real credentials).

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
const { OpenAIAdapter } = await import("@/lib/adk/adapters/openai-adapter");
const { VeloraEngineAdapter } = await import("@/lib/adk/engine-adapter");
const { isBaseLlm } = await import("@google/adk");

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRequest(overrides: Partial<LlmRequest> = {}): LlmRequest {
  return {
    contents: [{ role: "user", parts: [{ text: "Hello" }] }],
    liveConnectConfig: {},
    toolsDict: {},
    ...overrides,
  } as LlmRequest;
}

function makeOpenAIResponse(content: string, usage = true) {
  return {
    id: "chatcmpl-test",
    model: "gpt-4o-mini",
    choices: [
      { index: 0, message: { role: "assistant", content }, finish_reason: "stop" },
    ],
    ...(usage && {
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    }),
  };
}

function stubFetch(responseBody: unknown, status = 200) {
  const mockFetch = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(responseBody),
    text: vi.fn().mockResolvedValue(JSON.stringify(responseBody)),
  });
  vi.stubGlobal("fetch", mockFetch);
  return mockFetch;
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  process.env.OPENAI_API_KEY = "sk-test-key";
  delete process.env.OPENAI_MODEL;
  delete process.env.ENGINE;
  vi.unstubAllGlobals();
});

afterEach(() => {
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_MODEL;
  delete process.env.ENGINE;
  vi.unstubAllGlobals();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("OpenAIAdapter — identity / type guards", () => {
  it("is an instance of VeloraEngineAdapter", () => {
    const adapter = new OpenAIAdapter();
    expect(adapter).toBeInstanceOf(VeloraEngineAdapter);
  });

  it("passes the ADK isBaseLlm type guard", () => {
    const adapter = new OpenAIAdapter();
    expect(isBaseLlm(adapter)).toBe(true);
  });

  it("exposes the resolved model string", () => {
    const adapter = new OpenAIAdapter({ model: "gpt-4o" });
    expect(adapter.model).toBe("gpt-4o");
  });

  it("defaults to gpt-4o-mini when model is omitted", () => {
    const adapter = new OpenAIAdapter();
    expect(adapter.model).toBe("gpt-4o-mini");
  });

  it("reads OPENAI_MODEL env var when params.model is not set", () => {
    process.env.OPENAI_MODEL = "gpt-4o";
    const adapter = new OpenAIAdapter();
    expect(adapter.model).toBe("gpt-4o");
  });

  it("throws at construction when OPENAI_API_KEY is absent", () => {
    delete process.env.OPENAI_API_KEY;
    expect(() => new OpenAIAdapter()).toThrow(/OPENAI_API_KEY/);
  });
});

describe("OpenAIAdapter — generateContentAsync", () => {
  it("yields one LlmResponse with content from choices[0]", async () => {
    stubFetch(makeOpenAIResponse("Hi there!"));
    const adapter = new OpenAIAdapter();
    const gen = adapter.generateContentAsync(makeRequest());
    const { value } = await gen.next();
    const resp = value as LlmResponse;
    expect(resp.content?.role).toBe("model");
    expect(resp.content?.parts?.[0]).toEqual({ text: "Hi there!" });
  });

  it("maps user content role correctly in the outgoing payload", async () => {
    const mockFetch = stubFetch(makeOpenAIResponse("ok"));
    const adapter = new OpenAIAdapter();
    await adapter.generateContentAsync(makeRequest()).next();

    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    const userMsg = body.messages.find((m: { role: string }) => m.role === "user");
    expect(userMsg?.content).toBe("Hello");
  });

  it("maps model/assistant role to 'assistant' in the outgoing payload", async () => {
    const mockFetch = stubFetch(makeOpenAIResponse("ok"));
    const adapter = new OpenAIAdapter();
    const req = makeRequest({
      contents: [
        { role: "user", parts: [{ text: "Hi" }] },
        { role: "model", parts: [{ text: "Hello" }] },
      ],
    });
    await adapter.generateContentAsync(req).next();

    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    const assistantMsg = body.messages.find((m: { role: string }) => m.role === "assistant");
    expect(assistantMsg?.content).toBe("Hello");
  });

  it("prepends a system message when systemInstruction is set", async () => {
    const mockFetch = stubFetch(makeOpenAIResponse("ok"));
    const adapter = new OpenAIAdapter();
    const req = makeRequest({
      config: {
        systemInstruction: {
          role: "system",
          parts: [{ text: "You are a helpful assistant." }],
        },
      } as LlmRequest["config"],
    });
    await adapter.generateContentAsync(req).next();

    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(body.messages[0]).toEqual({
      role: "system",
      content: "You are a helpful assistant.",
    });
  });

  it("populates usageMetadata when OpenAI usage is present", async () => {
    stubFetch(makeOpenAIResponse("ok", true));
    const adapter = new OpenAIAdapter();
    const { value } = await adapter.generateContentAsync(makeRequest()).next();
    const resp = value as LlmResponse;
    expect(resp.usageMetadata?.promptTokenCount).toBe(10);
    expect(resp.usageMetadata?.candidatesTokenCount).toBe(20);
    expect(resp.usageMetadata?.totalTokenCount).toBe(30);
  });

  it("returns errorCode when choices is empty", async () => {
    stubFetch({ id: "x", model: "gpt-4o-mini", choices: [] });
    const adapter = new OpenAIAdapter();
    const { value } = await adapter.generateContentAsync(makeRequest()).next();
    const resp = value as LlmResponse;
    expect(resp.errorCode).toBe("no_choices");
  });

  it("throws on non-OK HTTP status", async () => {
    stubFetch({ error: { message: "Unauthorized" } }, 401);
    const adapter = new OpenAIAdapter();
    await expect(adapter.generateContentAsync(makeRequest()).next()).rejects.toThrow(/401/);
  });

  it("sends Authorization header with Bearer token", async () => {
    process.env.OPENAI_API_KEY = "sk-secret-key";
    const mockFetch = stubFetch(makeOpenAIResponse("ok"));
    const adapter = new OpenAIAdapter();
    await adapter.generateContentAsync(makeRequest()).next();

    const headers = mockFetch.mock.calls[0][1].headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-secret-key");
  });

  it("uses the configured model in the request body", async () => {
    const mockFetch = stubFetch(makeOpenAIResponse("ok"));
    const adapter = new OpenAIAdapter({ model: "gpt-4o" });
    await adapter.generateContentAsync(makeRequest()).next();

    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(body.model).toBe("gpt-4o");
  });
});

describe("OpenAIAdapter — connect()", () => {
  it("throws with a clear message about not being implemented", () => {
    const adapter = new OpenAIAdapter();
    expect(() => adapter.connect({} as LlmRequest)).toThrow(/not implemented/i);
  });
});

describe("engine-factory — ENGINE=openai", () => {
  it('ENGINE="openai" → createEngineModel returns an OpenAIAdapter', async () => {
    process.env.ENGINE = "openai";
    const { createEngineModel } = await import("@/lib/adk/engine-factory");
    const model = createEngineModel({ model: "gpt-4o-mini", project: "p", location: "l" });
    expect(model).toBeInstanceOf(OpenAIAdapter);
  });

  it('ENGINE="openai" → factory error message names all supported engines', async () => {
    process.env.ENGINE = "bogus-engine";
    const { createEngineModel } = await import("@/lib/adk/engine-factory");
    expect(() => createEngineModel({ model: "gpt-4o-mini", project: "p", location: "l" }))
      .toThrow(/openai/);
  });
});

// ── Tool-calling tests ────────────────────────────────────────────────────────

/** Helper: stub fetch to return a tool_calls assistant response. */
function makeToolCallResponse(calls: Array<{ id: string; name: string; args: unknown }>) {
  return {
    id: "chatcmpl-tool-test",
    model: "gpt-4o-mini",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: calls.map((c) => ({
            id: c.id,
            type: "function",
            function: { name: c.name, arguments: JSON.stringify(c.args) },
          })),
        },
        finish_reason: "tool_calls",
      },
    ],
  };
}

describe("OpenAIAdapter — tool declarations (request → OpenAI payload)", () => {
  it("sends tools[] when config.tools has function declarations", async () => {
    const mockFetch = stubFetch(makeOpenAIResponse("ok"));
    const adapter = new OpenAIAdapter();

    const req = makeRequest({
      // Cast via unknown: Schema.type expects the Type enum, but plain strings work
      // at runtime and this is a test — we want the ADK shape, not genai strict types.
      config: {
        tools: [
          {
            functionDeclarations: [
              {
                name: "get_weather",
                description: "Returns current weather",
                parameters: {
                  type: "object",
                  properties: { location: { type: "string" } },
                  required: ["location"],
                },
              },
            ],
          },
        ],
      } as unknown as LlmRequest["config"],
    });

    await adapter.generateContentAsync(req).next();

    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0].type).toBe("function");
    expect(body.tools[0].function.name).toBe("get_weather");
    expect(body.tools[0].function.description).toBe("Returns current weather");
    expect(body.tools[0].function.parameters).toEqual({
      type: "object",
      properties: { location: { type: "string" } },
      required: ["location"],
    });
  });

  it("sends multiple function declarations from a single Tool entry", async () => {
    const mockFetch = stubFetch(makeOpenAIResponse("ok"));
    const adapter = new OpenAIAdapter();

    const req = makeRequest({
      config: {
        tools: [
          {
            functionDeclarations: [
              { name: "fn_a", description: "A" },
              { name: "fn_b", description: "B" },
            ],
          },
        ],
      } as LlmRequest["config"],
    });

    await adapter.generateContentAsync(req).next();

    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(body.tools).toHaveLength(2);
    expect(body.tools.map((t: { function: { name: string } }) => t.function.name)).toEqual(["fn_a", "fn_b"]);
  });

  it("omits tools from payload when config.tools is absent", async () => {
    const mockFetch = stubFetch(makeOpenAIResponse("ok"));
    const adapter = new OpenAIAdapter();
    await adapter.generateContentAsync(makeRequest()).next();

    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(body.tools).toBeUndefined();
  });
});

describe("OpenAIAdapter — functionResponse → role:tool message (request direction)", () => {
  it("maps a functionResponse Content part to a role:tool message", async () => {
    const mockFetch = stubFetch(makeOpenAIResponse("ok"));
    const adapter = new OpenAIAdapter();

    const req = makeRequest({
      contents: [
        { role: "user", parts: [{ text: "What is the weather?" }] },
        // Simulates the model's prior tool-call turn (assistant with tool_calls).
        {
          role: "model",
          parts: [
            {
              functionCall: {
                id: "call_abc123",
                name: "get_weather",
                args: { location: "Paris" },
              },
            },
          ],
        },
        // Tool result turn — role "tool" with functionResponse part.
        {
          role: "tool",
          parts: [
            {
              functionResponse: {
                id: "call_abc123",
                name: "get_weather",
                response: { temperature: "25C" },
              },
            },
          ],
        },
      ],
    });

    await adapter.generateContentAsync(req).next();

    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    const toolMsg = body.messages.find((m: { role: string }) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    expect(toolMsg.tool_call_id).toBe("call_abc123");
    expect(JSON.parse(toolMsg.content)).toEqual({ temperature: "25C" });
  });

  it("maps model turn with functionCall to role:assistant + tool_calls[] in payload", async () => {
    const mockFetch = stubFetch(makeOpenAIResponse("ok"));
    const adapter = new OpenAIAdapter();

    const req = makeRequest({
      contents: [
        { role: "user", parts: [{ text: "Call get_weather" }] },
        {
          role: "model",
          parts: [
            {
              functionCall: {
                id: "call_xyz",
                name: "get_weather",
                args: { location: "Buenos Aires" },
              },
            },
          ],
        },
      ],
    });

    await adapter.generateContentAsync(req).next();

    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    const assistantMsg = body.messages.find(
      (m: { role: string; tool_calls?: unknown }) => m.role === "assistant" && m.tool_calls,
    );
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg.content).toBeNull();
    expect(assistantMsg.tool_calls).toHaveLength(1);
    expect(assistantMsg.tool_calls[0].id).toBe("call_xyz");
    expect(assistantMsg.tool_calls[0].type).toBe("function");
    expect(assistantMsg.tool_calls[0].function.name).toBe("get_weather");
    // arguments must be a JSON string
    expect(typeof assistantMsg.tool_calls[0].function.arguments).toBe("string");
    expect(JSON.parse(assistantMsg.tool_calls[0].function.arguments)).toEqual({
      location: "Buenos Aires",
    });
  });
});

describe("OpenAIAdapter — tool_calls in response → LlmResponse functionCall parts", () => {
  it("yields LlmResponse with functionCall part when OpenAI returns tool_calls", async () => {
    stubFetch(makeToolCallResponse([{ id: "call_001", name: "get_weather", args: { location: "Rome" } }]));
    const adapter = new OpenAIAdapter();
    const { value } = await adapter.generateContentAsync(makeRequest()).next();
    const resp = value as LlmResponse;

    expect(resp.content?.role).toBe("model");
    expect(resp.content?.parts).toHaveLength(1);
    const part = resp.content?.parts?.[0];
    expect(part?.functionCall).toBeDefined();
    expect(part?.functionCall?.name).toBe("get_weather");
    // args must be a parsed object, not a raw JSON string
    expect(part?.functionCall?.args).toEqual({ location: "Rome" });
    // id is preserved for correlation with the follow-up functionResponse
    expect(part?.functionCall?.id).toBe("call_001");
  });

  it("maps multiple tool_calls to multiple functionCall parts", async () => {
    stubFetch(
      makeToolCallResponse([
        { id: "call_A", name: "fn_a", args: { x: 1 } },
        { id: "call_B", name: "fn_b", args: { y: 2 } },
      ]),
    );
    const adapter = new OpenAIAdapter();
    const { value } = await adapter.generateContentAsync(makeRequest()).next();
    const resp = value as LlmResponse;

    expect(resp.content?.parts).toHaveLength(2);
    expect(resp.content?.parts?.[0]?.functionCall?.name).toBe("fn_a");
    expect(resp.content?.parts?.[1]?.functionCall?.name).toBe("fn_b");
    expect(resp.content?.parts?.[1]?.functionCall?.id).toBe("call_B");
  });

  it("parses tool_calls.function.arguments JSON string into an args object", async () => {
    stubFetch(makeToolCallResponse([{ id: "c1", name: "fn", args: { nested: { val: 42 } } }]));
    const adapter = new OpenAIAdapter();
    const { value } = await adapter.generateContentAsync(makeRequest()).next();
    const resp = value as LlmResponse;

    // Must be an object, not a string
    expect(typeof resp.content?.parts?.[0]?.functionCall?.args).toBe("object");
    expect(resp.content?.parts?.[0]?.functionCall?.args).toEqual({ nested: { val: 42 } });
  });

  it("falls back to _raw key when tool_calls.function.arguments is invalid JSON", async () => {
    const badResponse = {
      id: "chatcmpl-bad",
      model: "gpt-4o-mini",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: "c1", type: "function", function: { name: "fn", arguments: "NOT_JSON" } },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    };
    stubFetch(badResponse);
    const adapter = new OpenAIAdapter();
    const { value } = await adapter.generateContentAsync(makeRequest()).next();
    const resp = value as LlmResponse;

    expect(resp.content?.parts?.[0]?.functionCall?.args).toEqual({ _raw: "NOT_JSON" });
  });

  it("uses text path (not tool_calls) when finish_reason is stop", async () => {
    stubFetch(makeOpenAIResponse("Plain text answer"));
    const adapter = new OpenAIAdapter();
    const { value } = await adapter.generateContentAsync(makeRequest()).next();
    const resp = value as LlmResponse;

    // Must be text, not functionCall
    expect(resp.content?.parts?.[0]?.text).toBe("Plain text answer");
    expect(resp.content?.parts?.[0]?.functionCall).toBeUndefined();
  });
});

describe("OpenAIAdapter — full round-trip: tool declarations + prior functionResponse", () => {
  it("sends tools + tool result message in a single request payload", async () => {
    const mockFetch = stubFetch(makeOpenAIResponse("The weather in Paris is 25°C."));
    const adapter = new OpenAIAdapter();

    const req = makeRequest({
      // Cast via unknown: Schema.type expects Type enum; plain strings work at runtime.
      config: {
        tools: [
          {
            functionDeclarations: [
              {
                name: "get_weather",
                description: "Get weather",
                parameters: { type: "object", properties: { location: { type: "string" } } },
              },
            ],
          },
        ],
      } as unknown as LlmRequest["config"],
      contents: [
        { role: "user", parts: [{ text: "Weather in Paris?" }] },
        {
          role: "model",
          parts: [{ functionCall: { id: "call_p1", name: "get_weather", args: { location: "Paris" } } }],
        },
        {
          role: "tool",
          parts: [{ functionResponse: { id: "call_p1", name: "get_weather", response: { temp: "25C" } } }],
        },
      ],
    });

    await adapter.generateContentAsync(req).next();

    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);

    // tools[] must be present
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0].function.name).toBe("get_weather");

    // messages must include: user, assistant+tool_calls, tool result
    const roles = body.messages.map((m: { role: string }) => m.role);
    expect(roles).toContain("user");
    expect(roles).toContain("tool");
    const assistantMsg = body.messages.find(
      (m: { role: string; tool_calls?: unknown }) => m.role === "assistant" && m.tool_calls,
    );
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg.tool_calls[0].id).toBe("call_p1");

    const toolMsg = body.messages.find((m: { role: string }) => m.role === "tool");
    expect(toolMsg.tool_call_id).toBe("call_p1");
  });
});
