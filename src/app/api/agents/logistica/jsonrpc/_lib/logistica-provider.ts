// Shared types for the Logística role-agent provider layer.
// Adapters (AndreaniAdapter, OcaAdapter, CorreoAdapter) implement ProviderAdapter.
// The courier registry (courier-registry.ts) is the single place that lists all
// known couriers — tools import from there, not here.

// ── Shared JSON-RPC types ─────────────────────────────────────────────────────

export interface JsonRpcErrorBody {
  jsonrpc: "2.0";
  id: unknown;
  error: { code: number; message: string; data?: unknown };
}

/** Shape of the `result` field returned by all Logística adapters.
 *  Content MUST live in `parts` so that `sendStructured` (a2a-client.ts)
 *  extracts clean text via the parts path — never in a flat `text` field. */
export interface LogisticaResultMessage {
  kind: "message";
  messageId: string;
  role: "agent";
  contextId: string;
  skill: string;
  parts: Array<{ kind: "text"; text: string }>;
  mock?: boolean;
  result?: unknown; // raw structured payload (optional, kept for downstream consumers)
}

export interface JsonRpcResultBody {
  jsonrpc: "2.0";
  id: unknown;
  result: LogisticaResultMessage;
}

export type JsonRpcResponse = JsonRpcErrorBody | JsonRpcResultBody;

// ── Provider interface ────────────────────────────────────────────────────────

export interface ProviderAdapter {
  quote(params: Record<string, unknown>, businessId: string): Promise<JsonRpcResponse>;
  create(params: Record<string, unknown>, businessId: string): Promise<JsonRpcResponse>;
  track(params: Record<string, unknown>, businessId: string): Promise<JsonRpcResponse>;
}

