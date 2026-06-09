// claude-adapter.ts — Anthropic (Claude) Messages engine adapter.
//
// VeloraEngineAdapter implementation that lets Claude be the engine behind the
// ADK agent layer, exactly like GeminiAdapter / OpenAIAdapter. Selected via
// ENGINE=claude (engine-factory.ts). Off by default — Gemini stays the default.
//
// API source (HTTP 200 verified 2026-06-03):
//   https://platform.claude.com/docs/en/api/messages
//   POST https://api.anthropic.com/v1/messages
//   Required headers: content-type, anthropic-version: 2023-06-01, x-api-key
//   Required body:    { model, max_tokens, messages }  (system + tools optional)
//   Response:         { content: [{type:"text"|"tool_use", ...}], usage }
//
// Translation layer (ADK ↔ Anthropic) — see _lib/anthropic-tool-mapping.ts.
// Unlike OpenAI: the system prompt is a TOP-LEVEL field (not a message), tool
// results are USER messages with tool_result blocks, and tool_use.input is an
// object (no JSON.parse). That is why this is a real adapter, not a copy.
//
// Live use requires:
//   ANTHROPIC_API_KEY  — key from https://console.anthropic.com/settings/keys
//   ENGINE=claude      — selects this adapter via engine-factory.ts
//   ANTHROPIC_MODEL    — optional, defaults to "claude-sonnet-4-5"
//   ANTHROPIC_MAX_TOKENS — optional, defaults to 1500 (mirrors Supervisor cap)
//
// connect() is a stub: the Messages API has no bidirectional live connection
// equivalent to Gemini's Live API, and Velora's agent flow uses only
// generateContentAsync. Throw clearly if ever invoked.
// ─────────────────────────────────────────────────────────────────────────────

import type { BaseLlmConnection, LlmRequest, LlmResponse } from "@google/adk";
import type { Content } from "@google/genai";
import { VeloraEngineAdapter } from "../engine-adapter";
import {
  blocksToLlmResponse,
  buildToolDefinitions,
  contentToMessages,
  type AnthropicMessage,
  type AnthropicResponseBlock,
  type AnthropicToolDefinition,
} from "./_lib/anthropic-tool-mapping";

// ── Types for the Anthropic Messages REST API ────────────────────────────────

interface AnthropicMessagesRequest {
  model: string;
  max_tokens: number;
  messages: AnthropicMessage[];
  system?: string;
  tools?: AnthropicToolDefinition[];
}

interface AnthropicMessagesResponse {
  id: string;
  model: string;
  content: AnthropicResponseBlock[];
  stop_reason: string | null;
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
}

// ── Constants ─────────────────────────────────────────────────────────────────

const ANTHROPIC_ENDPOINT = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_CLAUDE_MODEL = "claude-sonnet-4-5";
const DEFAULT_MAX_TOKENS = 1500;

// ── Translation helpers ───────────────────────────────────────────────────────

function extractText(content: Content): string {
  return (content.parts ?? [])
    .filter((p): p is { text: string } => typeof (p as { text?: unknown }).text === "string")
    .map((p) => p.text)
    .join("");
}

/**
 * Builds the Anthropic { system, messages } pair from an LlmRequest.
 *
 * The system instruction maps to the TOP-LEVEL `system` field (Anthropic has no
 * "system" message role). Every other Content entry maps via contentToMessages.
 */
function buildPayloadBody(llmRequest: LlmRequest): {
  system?: string;
  messages: AnthropicMessage[];
} {
  const messages: AnthropicMessage[] = [];
  for (const content of llmRequest.contents) {
    messages.push(...contentToMessages(content));
  }

  const sysInstruction = llmRequest.config?.systemInstruction as Content | undefined;
  const system = sysInstruction ? extractText(sysInstruction) : "";

  return { ...(system && { system }), messages };
}

/**
 * Converts an Anthropic Messages response to an ADK LlmResponse.
 * usage.input_tokens/output_tokens map to ADK's prompt/candidate/total counts.
 */
function toLlmResponse(raw: AnthropicMessagesResponse): LlmResponse {
  if (!raw.content?.length) {
    return { errorCode: "no_content", errorMessage: "Anthropic returned 0 content blocks." };
  }

  const usageMetadata = raw.usage
    ? {
        promptTokenCount: raw.usage.input_tokens,
        candidatesTokenCount: raw.usage.output_tokens,
        totalTokenCount: raw.usage.input_tokens + raw.usage.output_tokens,
      }
    : undefined;

  return blocksToLlmResponse(raw.content, usageMetadata);
}

// ── Anthropic HTTP call ───────────────────────────────────────────────────────

async function callMessages(
  apiKey: string,
  payload: AnthropicMessagesRequest,
  abortSignal?: AbortSignal,
): Promise<AnthropicMessagesResponse> {
  const res = await fetch(ANTHROPIC_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "anthropic-version": ANTHROPIC_VERSION,
      "x-api-key": apiKey,
    },
    body: JSON.stringify(payload),
    signal: abortSignal,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "(unreadable)");
    throw new Error(`Anthropic API error ${res.status}: ${body}`);
  }

  return (await res.json()) as AnthropicMessagesResponse;
}

// ── Adapter ───────────────────────────────────────────────────────────────────

export interface ClaudeAdapterParams {
  /** Claude model to use. Defaults to ANTHROPIC_MODEL env var or "claude-sonnet-4-5". */
  model?: string;
  /** API key. Defaults to ANTHROPIC_API_KEY env var. */
  apiKey?: string;
  /** Max output tokens. Defaults to ANTHROPIC_MAX_TOKENS env var or 1500. */
  maxTokens?: number;
}

export class ClaudeAdapter extends VeloraEngineAdapter {
  static readonly supportedModels: Array<string | RegExp> = [/^claude-/i];

  private readonly _apiKey: string;
  private readonly _maxTokens: number;

  constructor(params: ClaudeAdapterParams = {}) {
    const resolvedModel =
      params.model ?? process.env.ANTHROPIC_MODEL ?? DEFAULT_CLAUDE_MODEL;
    super({ model: resolvedModel });

    const resolvedKey = params.apiKey ?? process.env.ANTHROPIC_API_KEY ?? "";
    if (!resolvedKey) {
      throw new Error(
        "ClaudeAdapter: ANTHROPIC_API_KEY is required. Set the env var or pass params.apiKey.",
      );
    }
    this._apiKey = resolvedKey;

    const envMax = Number(process.env.ANTHROPIC_MAX_TOKENS);
    this._maxTokens =
      params.maxTokens ?? (Number.isFinite(envMax) && envMax > 0 ? envMax : DEFAULT_MAX_TOKENS);
  }

  /**
   * Generates content by calling the Anthropic Messages API.
   *
   * Non-streaming only (stream param ignored — SSE consumption is out of scope,
   * matching the OpenAI adapter). Yields a single LlmResponse then returns.
   * Tool-calling is translated both directions via anthropic-tool-mapping.
   */
  async *generateContentAsync(
    llmRequest: LlmRequest,
    _stream?: boolean,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, void> {
    const { system, messages } = buildPayloadBody(llmRequest);
    const tools = buildToolDefinitions(llmRequest);
    const payload: AnthropicMessagesRequest = {
      model: this.model,
      max_tokens: this._maxTokens,
      messages,
      ...(system && { system }),
      ...(tools && { tools }),
    };
    const raw = await callMessages(this._apiKey, payload, abortSignal);
    yield toLlmResponse(raw);
  }

  /**
   * connect() is not implemented for the Anthropic Messages API.
   *
   * Gemini's connect() maps to the Gemini Live (bidirectional) API; Anthropic
   * has no equivalent in the Messages API. Velora's agent pipeline uses only
   * generateContentAsync, so connect() is never called on this path.
   */
  connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error(
      "ClaudeAdapter.connect() is not implemented. " +
        "The Anthropic Messages API has no equivalent to Gemini Live. " +
        "Use generateContentAsync for all Velora agent calls.",
    );
  }
}
