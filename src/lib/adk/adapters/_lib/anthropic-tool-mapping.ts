// anthropic-tool-mapping.ts — ADK ↔ Anthropic Messages tool-calling translation.
//
// Mirror of openai-tool-mapping.ts for the Anthropic (Claude) Messages API.
// Extracted from claude-adapter.ts to stay within the 250-line new-file limit.
//
// Translates in both directions:
//   Request:  ADK FunctionDeclarations → Anthropic tools[]
//             ADK functionCall/functionResponse Content parts → Anthropic messages
//   Response: Anthropic tool_use blocks → ADK LlmResponse Content with functionCall parts
//
// API source (HTTP 200 verified 2026-06-03):
//   https://platform.claude.com/docs/en/api/messages
//   POST https://api.anthropic.com/v1/messages
//   tool def:        { name, description, input_schema }   (input_schema is JSON Schema)
//   tool_use block:  { type:"tool_use", id, name, input }  (input is an OBJECT, not a JSON string)
//   tool_result:     user message → { type:"tool_result", tool_use_id, content }
//   roles:           only "user" | "assistant" (no "system"/"tool" role — system is top-level)
//
// Key differences from OpenAI (why this is NOT a copy-paste of openai-tool-mapping):
//   - Anthropic has NO "tool"/"system" message roles. Tool results are USER
//     messages with tool_result blocks; the system prompt is a top-level field.
//   - tool_use.input is already an object (OpenAI's arguments is a JSON string),
//     so no JSON.parse on the way in and no JSON.stringify on the way out.
//   - message.content is an array of typed blocks (text / tool_use / tool_result).
// ─────────────────────────────────────────────────────────────────────────────

import type { LlmRequest, LlmResponse } from "@google/adk";
import type { Content, FunctionDeclaration, Part, Tool } from "@google/genai";

// ── Anthropic message + block types (re-exported for claude-adapter.ts) ────────

export interface AnthropicTextBlock {
  type: "text";
  text: string;
}

export interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  /** Already an object — no JSON.parse needed (unlike OpenAI's arguments string). */
  input: Record<string, unknown>;
}

export interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
}

export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock;

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

export interface AnthropicToolDefinition {
  name: string;
  description?: string;
  /** JSON Schema object: { type:"object", properties, required? }. */
  input_schema: Record<string, unknown>;
}

// ── Request direction: ADK → Anthropic ───────────────────────────────────────

/**
 * Converts ADK function declarations from LlmRequest.config.tools into
 * Anthropic tool definitions.
 *
 * Each FunctionDeclaration maps to { name, description?, input_schema }.
 * Anthropic REQUIRES input_schema, so a declaration without parameters falls
 * back to an empty object schema rather than being emitted without one.
 */
export function buildToolDefinitions(
  llmRequest: LlmRequest,
): AnthropicToolDefinition[] | undefined {
  const toolList = llmRequest.config?.tools as Tool[] | undefined;
  if (!toolList?.length) return undefined;

  const defs: AnthropicToolDefinition[] = [];
  for (const tool of toolList) {
    const decls: FunctionDeclaration[] = tool.functionDeclarations ?? [];
    for (const decl of decls) {
      if (!decl.name) continue;
      defs.push({
        name: decl.name,
        ...(decl.description && { description: decl.description }),
        input_schema:
          (decl.parameters as Record<string, unknown> | undefined) ?? {
            type: "object",
            properties: {},
          },
      });
    }
  }
  return defs.length > 0 ? defs : undefined;
}

/**
 * Converts a single ADK Content entry into one or more Anthropic messages.
 *
 * Three cases:
 *  1. "tool" / "function" role — functionResponse parts → ONE user message whose
 *     content is an array of tool_result blocks (Anthropic groups results).
 *  2. "model" role with functionCall parts → assistant message with tool_use
 *     blocks (plus a leading text block if the model also produced text).
 *  3. All other roles — text extraction → user or assistant message (string).
 */
export function contentToMessages(content: Content): AnthropicMessage[] {
  const role = content.role ?? "user";
  const parts: Part[] = content.parts ?? [];

  // Case 1: tool result turn — Anthropic sends results as a USER message.
  if (role === "tool" || role === "function") {
    const blocks: AnthropicContentBlock[] = parts
      .filter((p) => p.functionResponse != null)
      .map((p) => {
        const fr = p.functionResponse!;
        return {
          type: "tool_result",
          tool_use_id: fr.id ?? fr.name ?? "unknown",
          content: fr.response != null ? JSON.stringify(fr.response) : "",
        } satisfies AnthropicToolResultBlock;
      });
    return blocks.length ? [{ role: "user", content: blocks }] : [];
  }

  // Case 2: model turn with function calls → assistant + tool_use blocks.
  const functionCallParts = parts.filter((p) => p.functionCall != null);
  if (role === "model" && functionCallParts.length > 0) {
    const blocks: AnthropicContentBlock[] = [];
    const text = extractText(content);
    if (text) blocks.push({ type: "text", text });
    for (const p of functionCallParts) {
      const fc = p.functionCall!;
      blocks.push({
        type: "tool_use",
        id: fc.id ?? fc.name ?? "call_unknown",
        name: fc.name ?? "",
        input: (fc.args as Record<string, unknown> | undefined) ?? {},
      });
    }
    return [{ role: "assistant", content: blocks }];
  }

  // Case 3: plain text turn.
  const text = extractText(content);
  if (!text) return [];
  return [{ role: role === "model" ? "assistant" : "user", content: text }];
}

// ── Response direction: Anthropic → ADK ──────────────────────────────────────

export interface AnthropicResponseBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

/**
 * Maps an Anthropic response content[] array to an ADK LlmResponse.
 *
 * If any tool_use blocks are present they become functionCall parts (the id is
 * preserved as FunctionCall.id so the follow-up tool_result can reference it).
 * Otherwise all text blocks are concatenated into a single text part.
 */
export function blocksToLlmResponse(
  blocks: AnthropicResponseBlock[],
  usageMetadata?: LlmResponse["usageMetadata"],
): LlmResponse {
  const toolUseBlocks = blocks.filter((b) => b.type === "tool_use");
  if (toolUseBlocks.length > 0) {
    const parts: Part[] = toolUseBlocks.map((b) => ({
      functionCall: { id: b.id, name: b.name ?? "", args: b.input ?? {} },
    }));
    return { content: { role: "model", parts }, ...(usageMetadata && { usageMetadata }) };
  }

  const text = blocks
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("");
  return {
    content: { role: "model", parts: [{ text }] },
    ...(usageMetadata && { usageMetadata }),
  };
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function extractText(content: Content): string {
  return (content.parts ?? [])
    .filter((p): p is { text: string } => typeof (p as { text?: unknown }).text === "string")
    .map((p) => p.text)
    .join("");
}
