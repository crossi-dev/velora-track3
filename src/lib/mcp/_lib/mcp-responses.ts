// src/lib/mcp/_lib/mcp-responses.ts — Canonical MCP error response builder.
//
// Single source of truth for the error shape returned by ALL Velora MCP tools.
// Canonical shape: { content: [{ type: "text", text: JSON.stringify({ code, message }) }], isError: true }
// This ensures every tool returns consistent error JSON so any MCP client
// (Claude Code, ChatGPT, Cowork, etc.) can parse errors uniformly.

/**
 * Builds a standard MCP error response.
 * @param code  - Machine-readable error code (e.g. "NOT_FOUND", "VALIDATION_ERROR").
 * @param message - Human-readable error message.
 */
export function errResponse(code: string, message: string) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ code, message }) }],
    isError: true,
  };
}
