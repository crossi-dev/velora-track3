// openai-adapter.ts — OpenAI Chat Completions engine adapter (VeloraEngineAdapter implementation).
//
// Proves the engine-agnostic seam: the ADK layer routes through the same
// VeloraEngineAdapter port whether Gemini or OpenAI is the backend.
//
// API sources (HTTP 200 verified 2026-06-02):
//   Chat Completions: https://developers.openai.com/api/docs/api-reference/chat/create
//   Function calling: https://developers.openai.com/api/docs/guides/function-calling
//   POST https://api.openai.com/v1/chat/completions
//   Required: { model, messages: Array<{ role, content }> }
//   Response: { id, choices: [{ message: { role, content, tool_calls? }, finish_reason }], usage }
//
// Translation layer (ADK ↔ OpenAI) — implemented in _lib/openai-tool-mapping.ts:
//   LlmRequest.config.systemInstruction          → role:"system" message (prepended)
//   Content.role "user"                          → role:"user"
//   Content.role "model" (text)                  → role:"assistant" with content
//   Content.role "model" (functionCall part)     → role:"assistant" with tool_calls[]
//   Content.role "tool" / "function" (resp part) → role:"tool" with tool_call_id + content
//   LlmRequest.config.tools (functionDeclarations) → tools:[{type:"function", function:{...}}]
//   OpenAI tool_calls[] in response              → LlmResponse Content parts with functionCall
//
// Live use requires:
//   OPENAI_API_KEY env var — API key from https://platform.openai.com/api-keys
//   ENGINE=openai env var — selects this adapter via engine-factory.ts
//   OPENAI_MODEL env var — optional, defaults to "gpt-4o-mini"
//
// connect() is a stub (not-implemented): OpenAI Chat Completions has no live
// bidirectional streaming connection equivalent to Gemini's multimodal Live API.
// Velora does not use connect() in its current agent flow (all paths use
// generateContentAsync). Throw clearly if called to surface the gap.
//
// ─────────────────────────────────────────────────────────────────────────────

import type { BaseLlmConnection, LlmRequest, LlmResponse } from "@google/adk";
import type { Content } from "@google/genai";
import { VeloraEngineAdapter } from "../engine-adapter";
import {
  buildToolDefinitions,
  contentToMessages,
  toolCallsToLlmResponse,
  type OpenAIMessage,
  type OpenAIToolCall,
  type OpenAIToolDefinition,
} from "./_lib/openai-tool-mapping";

// ── Types for the OpenAI Chat Completions REST API ───────────────────────────
// Sourced from: https://developers.openai.com/api/docs/api-reference/chat/create

interface OpenAIChatCompletionRequest {
  model: string;
  messages: OpenAIMessage[];
  tools?: OpenAIToolDefinition[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
}

interface OpenAIChatCompletionChoice {
  index: number;
  message: {
    role: "assistant";
    content: string | null;
    tool_calls?: OpenAIToolCall[];
  };
  finish_reason: string;
}

interface OpenAIChatCompletionResponse {
  id: string;
  model: string;
  choices: OpenAIChatCompletionChoice[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

// ── Constants ─────────────────────────────────────────────────────────────────

const OPENAI_CHAT_ENDPOINT = "https://api.openai.com/v1/chat/completions";
const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";

// ── Translation helpers ───────────────────────────────────────────────────────

/**
 * Extracts the plain-text string from a Content.parts array.
 * Only text parts are collected; function-call / blob parts are skipped.
 */
function extractText(content: Content): string {
  return (content.parts ?? [])
    .filter((p): p is { text: string } => typeof (p as { text?: unknown }).text === "string")
    .map((p) => p.text)
    .join("");
}

/**
 * Converts an LlmRequest into an OpenAI messages array.
 *
 * Prepends a system message if LlmRequest.config.systemInstruction is set.
 * Maps each Content[] entry via contentToMessages (handles text, tool calls, tool results).
 */
function buildMessages(llmRequest: LlmRequest): OpenAIMessage[] {
  const messages: OpenAIMessage[] = [];

  const sysInstruction = llmRequest.config?.systemInstruction as Content | undefined;
  if (sysInstruction) {
    const text = extractText(sysInstruction);
    if (text) messages.push({ role: "system", content: text });
  }

  for (const content of llmRequest.contents) {
    messages.push(...contentToMessages(content));
  }

  return messages;
}

/**
 * Converts an OpenAI Chat Completion response to an ADK LlmResponse.
 *
 * Two response shapes:
 *  - tool_calls present → functionCall parts in LlmResponse Content.
 *  - plain text → single text Part (original behaviour, unchanged).
 */
function toLlmResponse(raw: OpenAIChatCompletionResponse): LlmResponse {
  const choice = raw.choices[0];
  if (!choice) {
    return { errorCode: "no_choices", errorMessage: "OpenAI returned 0 choices." };
  }

  const usageMetadata = raw.usage
    ? {
        promptTokenCount: raw.usage.prompt_tokens,
        candidatesTokenCount: raw.usage.completion_tokens,
        totalTokenCount: raw.usage.total_tokens,
      }
    : undefined;

  if (choice.message.tool_calls?.length) {
    return toolCallsToLlmResponse(choice.message.tool_calls, usageMetadata);
  }

  return {
    content: {
      role: "model",
      parts: [{ text: choice.message.content ?? "" }],
    },
    ...(usageMetadata && { usageMetadata }),
  };
}

// ── OpenAI HTTP call ──────────────────────────────────────────────────────────

/**
 * Calls POST /v1/chat/completions and returns the parsed response.
 * Throws on HTTP errors or JSON parse failures.
 */
async function callChatCompletions(
  apiKey: string,
  payload: OpenAIChatCompletionRequest,
  abortSignal?: AbortSignal,
): Promise<OpenAIChatCompletionResponse> {
  const res = await fetch(OPENAI_CHAT_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
    signal: abortSignal,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "(unreadable)");
    throw new Error(`OpenAI API error ${res.status}: ${body}`);
  }

  return (await res.json()) as OpenAIChatCompletionResponse;
}

// ── Adapter ───────────────────────────────────────────────────────────────────

export interface OpenAIAdapterParams {
  /** OpenAI model to use. Defaults to OPENAI_MODEL env var or "gpt-4o-mini". */
  model?: string;
  /** API key. Defaults to OPENAI_API_KEY env var. */
  apiKey?: string;
}

export class OpenAIAdapter extends VeloraEngineAdapter {
  /** No fixed supportedModels list: OpenAI has a large open set of model IDs. */
  static readonly supportedModels: Array<string | RegExp> = [/^gpt-/i, /^o[0-9]/i];

  private readonly _apiKey: string;

  constructor(params: OpenAIAdapterParams = {}) {
    const resolvedModel =
      params.model ?? process.env.OPENAI_MODEL ?? DEFAULT_OPENAI_MODEL;
    super({ model: resolvedModel });

    const resolvedKey = params.apiKey ?? process.env.OPENAI_API_KEY ?? "";
    if (!resolvedKey) {
      throw new Error(
        "OpenAIAdapter: OPENAI_API_KEY is required. Set the env var or pass params.apiKey.",
      );
    }
    this._apiKey = resolvedKey;
  }

  /**
   * Generates content by calling the OpenAI Chat Completions API.
   *
   * Non-streaming only (stream param is ignored — OpenAI SSE streaming requires
   * a different response-consumption loop outside current scope).
   * Yields a single LlmResponse then returns, matching ADK's expected shape.
   *
   * Tool-calling is fully translated both directions:
   *   - FunctionDeclarations in config.tools → OpenAI tools[] in request
   *   - functionResponse Content parts → role:"tool" messages in request
   *   - OpenAI tool_calls in response → functionCall parts in LlmResponse Content
   */
  async *generateContentAsync(
    llmRequest: LlmRequest,
    _stream?: boolean,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, void> {
    const messages = buildMessages(llmRequest);
    const tools = buildToolDefinitions(llmRequest);
    const payload: OpenAIChatCompletionRequest = {
      model: this.model,
      messages,
      ...(tools && { tools }),
    };
    const raw = await callChatCompletions(this._apiKey, payload, abortSignal);
    yield toLlmResponse(raw);
  }

  /**
   * connect() is not implemented for OpenAI Chat Completions.
   *
   * Gemini's connect() maps to the Gemini Live (multimodal, bidirectional)
   * streaming API.  OpenAI Chat Completions has no equivalent live connection;
   * the Realtime API exists but is a separate protocol not part of this adapter.
   * Velora's current agent pipeline uses generateContentAsync only; connect() is
   * never called in the non-Live path.  Throw clearly if ever invoked.
   */
  connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error(
      "OpenAIAdapter.connect() is not implemented. " +
        "OpenAI Chat Completions has no equivalent to Gemini Live. " +
        "Use generateContentAsync for all Velora agent calls.",
    );
  }
}
