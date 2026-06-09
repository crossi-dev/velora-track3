// Canonical A2A JSON-RPC wire types shared across all five agent RPC handlers.
// Single source of truth — do NOT redeclare in individual handler files.

// ── JSON-RPC wire types ──────────────────────────────────────────────────────

export interface JsonRpcRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

export interface JsonRpcErrorBody {
  jsonrpc: "2.0";
  id: unknown;
  error: { code: number; message: string; data?: unknown };
}

export interface JsonRpcResultBody {
  jsonrpc: "2.0";
  id: unknown;
  result: unknown;
}

export type JsonRpcResponse = JsonRpcErrorBody | JsonRpcResultBody;

// ── A2A message part types ───────────────────────────────────────────────────

export interface A2ATextPart {
  kind: "text";
  text: string;
}

/** Structured data part — carries machine-readable payloads alongside text. */
export interface A2ADataPart {
  kind: "data";
  data: unknown;
}

export type A2APart = A2ATextPart | A2ADataPart;

// ── Error catalogue ──────────────────────────────────────────────────────────
// Canonical name is RPC_ERRORS. Handlers that previously used JSON_RPC_ERRORS
// must be updated to import this export directly.

export const RPC_ERRORS = {
  PARSE_ERROR:      { code: -32700, message: "Parse error" },
  INVALID_REQUEST:  { code: -32600, message: "Invalid Request" },
  METHOD_NOT_FOUND: { code: -32601, message: "Method not found" },
  INVALID_PARAMS:   { code: -32602, message: "Invalid params" },
  INTERNAL_ERROR:   { code: -32603, message: "Internal error" },
  TASK_NOT_FOUND:   { code: -32001, message: "Task not found" },
  AUTH_REQUIRED:    { code: -32004, message: "Authentication required" },
  RATE_LIMIT:       { code: -32005, message: "Rate limit exceeded" },
} as const;

// ── RPC helpers ──────────────────────────────────────────────────────────────

export function rpcError(
  id: unknown,
  error: { code: number; message: string },
  data?: unknown,
): JsonRpcErrorBody {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: { ...error, ...(data !== undefined ? { data } : {}) },
  };
}

export function rpcResult(id: unknown, result: unknown): JsonRpcResultBody {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

// ── Agent intent capture ──────────────────────────────────────────────────────

/**
 * Pattern C intent captured from a sub-agent tool response.
 * Ventas, Equipo, and Communications handlers capture these from ADK
 * FunctionResponse events and forward them as A2A dataParts so the supervisor
 * pipeline can materialise them through the mutation contract.
 * Canonical — do NOT redeclare in individual handler files.
 */
export interface CapturedIntent {
  intent: string;
  data: unknown;
  summary: string;
}

// ── Param extraction helpers ─────────────────────────────────────────────────

/** Max input length for A2A text payloads — anti-DoS cap. */
export const A2A_MAX_INPUT_CHARS = 4_000;

/**
 * Extracts and concatenates all text parts from an A2A message/send params object.
 * Returns null if no non-empty text is found.
 */
export function extractTextFromParams(params: unknown): string | null {
  if (!params || typeof params !== "object") return null;
  const message = (params as { message?: unknown }).message;
  if (!message || typeof message !== "object") return null;
  const parts = (message as { parts?: unknown }).parts;
  if (!Array.isArray(parts)) return null;
  const text = parts
    .filter(
      (p): p is A2ATextPart =>
        Boolean(p) &&
        typeof p === "object" &&
        (p as { kind?: unknown }).kind === "text" &&
        typeof (p as { text?: unknown }).text === "string",
    )
    .map((p) => p.text)
    .join("\n")
    .trim()
    .slice(0, A2A_MAX_INPUT_CHARS);
  return text || null;
}

/**
 * Extracts contextId from an A2A message/send params object.
 * Returns null if absent or not a non-empty string.
 */
export function extractContextIdFromParams(params: unknown): string | null {
  if (!params || typeof params !== "object") return null;
  const message = (params as { message?: unknown }).message;
  if (!message || typeof message !== "object") return null;
  const contextId = (message as { contextId?: unknown }).contextId;
  return typeof contextId === "string" && contextId.trim() ? contextId.trim() : null;
}

/**
 * Parses the businessId header line embedded in A2A text payloads.
 * Pattern: "businessId: <token>" anchored at line start (m flag).
 * Anchored + \S+ so trailing prose from the LLM is ignored.
 */
export function extractBusinessIdFromText(text: string): string | null {
  // Anchored to line-start (m flag); \S+ captures the id token only — no trailing
  // words if the LLM adds prose after the businessId line.
  const match = /^businessId:\s*(\S+)/m.exec(text);
  const value = match?.[1]?.trim() ?? null;
  return value && value.length > 0 ? value : null;
}

/**
 * Parses the invoiceId header line embedded in A2A text payloads.
 * Pattern: "invoiceId: <token>" anchored at line start (m flag).
 * Mirrors extractBusinessIdFromText — same CUID format, same capture strategy.
 * Used by the Fiscal Agent A2A route to pass invoiceId into handleFiscalRpc so
 * the emit-invoice tool can persist the CAE to the Invoice row (H1 fix).
 */
export function extractInvoiceIdFromText(text: string): string | null {
  const match = /^invoiceId:\s*(\S+)/m.exec(text);
  const value = match?.[1]?.trim() ?? null;
  return value && value.length > 0 ? value : null;
}

/**
 * Parses the invoiceDate header line embedded in A2A text payloads.
 * Pattern: "invoiceDate: YYYY-MM-DD" anchored at line start (m flag).
 * Used by the Fiscal Agent route to inject Sale.date into toolCtx so
 * emit-invoice-tool uses the actual sale date instead of today for
 * backdated sales (AFIP RG 4291 QR correctness — Audit 2E V2-1).
 */
export function extractInvoiceDateFromText(text: string): string | null {
  const match = /^invoiceDate:\s*(\d{4}-\d{2}-\d{2})/m.exec(text);
  const value = match?.[1]?.trim() ?? null;
  return value && value.length === 10 ? value : null;
}
