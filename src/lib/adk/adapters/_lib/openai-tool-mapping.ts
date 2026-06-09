// openai-tool-mapping.ts — ADK ↔ OpenAI tool-calling translation helpers.
//
// Extracted from openai-adapter.ts to stay within the 250-line new-file limit.
//
// Translates in both directions:
//   Request:  ADK FunctionDeclarations → OpenAI tools[]
//             ADK functionCall/functionResponse Content parts → OpenAI messages
//   Response: OpenAI tool_calls → ADK LlmResponse Content with functionCall parts
//
// API source (HTTP 200 verified 2026-06-02):
//   https://developers.openai.com/api/docs/guides/function-calling
//   tool_calls[].id           — correlation id (string)
//   tool_calls[].type         — "function"
//   tool_calls[].function.name
//   tool_calls[].function.arguments — JSON string (must be JSON.parse'd)
//   Tool result message: { role:"tool", tool_call_id, content: string }
//
// ─────────────────────────────────────────────────────────────────────────────

import type { LlmRequest, LlmResponse } from "@google/adk";
import type { Content, FunctionDeclaration, Part, Tool } from "@google/genai";

// ── Shared OpenAI message types (re-exported for openai-adapter.ts) ───────────

export interface OpenAITextMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface OpenAIAssistantToolCallMessage {
  role: "assistant";
  content: string | null;
  tool_calls: OpenAIToolCall[];
}

export interface OpenAIToolResultMessage {
  role: "tool";
  tool_call_id: string;
  content: string;
}

export type OpenAIMessage =
  | OpenAITextMessage
  | OpenAIAssistantToolCallMessage
  | OpenAIToolResultMessage;

export interface OpenAIToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    /** JSON-encoded string — must be JSON.parse'd to recover args. */
    arguments: string;
  };
}

export interface OpenAIToolDefinition {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

// ── Request direction: ADK → OpenAI ──────────────────────────────────────────

/**
 * Converts ADK function declarations from LlmRequest.config.tools into
 * OpenAI tool definitions.
 *
 * Each FunctionDeclaration maps to { type:"function", function:{name,description,parameters} }.
 * parameters is a JSON Schema object (Schema type in @google/genai — same shape OpenAI expects).
 */
export function buildToolDefinitions(llmRequest: LlmRequest): OpenAIToolDefinition[] | undefined {
  const toolList = llmRequest.config?.tools as Tool[] | undefined;
  if (!toolList?.length) return undefined;

  const defs: OpenAIToolDefinition[] = [];
  for (const tool of toolList) {
    const decls: FunctionDeclaration[] = tool.functionDeclarations ?? [];
    for (const decl of decls) {
      if (!decl.name) continue;
      defs.push({
        type: "function",
        function: {
          name: decl.name,
          ...(decl.description && { description: decl.description }),
          ...(decl.parameters && { parameters: decl.parameters as Record<string, unknown> }),
        },
      });
    }
  }
  return defs.length > 0 ? defs : undefined;
}

/**
 * Converts a single ADK Content entry into one or more OpenAI messages.
 *
 * Three cases:
 *  1. "tool" / "function" role — functionResponse parts → role:"tool" messages
 *  2. "model" role with functionCall parts → role:"assistant" with tool_calls[]
 *  3. All other roles — text extraction → role:"user" or role:"assistant"
 */
export function contentToMessages(content: Content): OpenAIMessage[] {
  const role = content.role ?? "user";
  const parts: Part[] = content.parts ?? [];

  // Case 1: tool result turn — ADK uses role "tool" or "function".
  if (role === "tool" || role === "function") {
    return parts
      .filter((p) => p.functionResponse != null)
      .map((p) => {
        const fr = p.functionResponse!;
        const toolCallId = fr.id ?? fr.name ?? "unknown";
        const responseContent = fr.response != null ? JSON.stringify(fr.response) : "";
        return { role: "tool", tool_call_id: toolCallId, content: responseContent } satisfies OpenAIToolResultMessage;
      });
  }

  // Case 2: model turn with function calls → role:"assistant" + tool_calls[].
  const functionCallParts = parts.filter((p) => p.functionCall != null);
  if (role === "model" && functionCallParts.length > 0) {
    const toolCalls: OpenAIToolCall[] = functionCallParts.map((p) => {
      const fc = p.functionCall!;
      return {
        id: fc.id ?? fc.name ?? "call_unknown",
        type: "function",
        function: {
          name: fc.name ?? "",
          // OpenAI arguments must be a JSON string.
          arguments: JSON.stringify(fc.args ?? {}),
        },
      };
    });
    return [{ role: "assistant", content: null, tool_calls: toolCalls }];
  }

  // Case 3: plain text turn.
  const text = extractText(content);
  if (!text) return [];
  const openAIRole = role === "model" ? "assistant" : "user";
  return [{ role: openAIRole, content: text }];
}

// ── Response direction: OpenAI → ADK ─────────────────────────────────────────

export interface OpenAIToolCallRaw {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/**
 * Maps OpenAI tool_calls[] to ADK LlmResponse Content with functionCall parts.
 *
 * The id from each tool_call is preserved as FunctionCall.id so the follow-up
 * functionResponse message can reference it via tool_call_id.
 * arguments is a JSON string from OpenAI — parsed back to an object for ADK.
 * On parse failure, surfaces raw string under the "_raw" key for debuggability.
 */
export function toolCallsToLlmResponse(
  toolCalls: OpenAIToolCallRaw[],
  usageMetadata?: LlmResponse["usageMetadata"],
): LlmResponse {
  const parts: Part[] = toolCalls.map((tc) => ({
    functionCall: {
      id: tc.id,
      name: tc.function.name,
      args: parseArgsSafe(tc.function.arguments),
    },
  }));
  return { content: { role: "model", parts }, ...(usageMetadata && { usageMetadata }) };
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function extractText(content: Content): string {
  return (content.parts ?? [])
    .filter((p): p is { text: string } => typeof (p as { text?: unknown }).text === "string")
    .map((p) => p.text)
    .join("");
}

function parseArgsSafe(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { _raw: raw };
  }
}
