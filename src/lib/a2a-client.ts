// A2A Protocol v0.3.0 client.
//
// Use cases:
//   1. Discover an external A2A agent's capabilities by fetching its agent card.
//   2. Send a synchronous message to that agent and receive a structured reply.
//
// Designed for Velora to consume external A2A agents (AFIP, Mercado Pago,
// supplier inventory, etc.) once they ship A2A endpoints. Works as an
// isomorphic fetch wrapper — runs in Node (Next.js routes) and the browser.
//
// Retry strategy: exponential backoff with full jitter — see a2a-retry.ts.
// Ref: https://cloud.google.com/iam/docs/retry-strategy

import { randomUUID } from "crypto";
import { fetchWithRetry } from "./a2a-retry";
import { traceCtxHeader } from "./a2a-trace-ctx";

export interface A2APart {
  kind: "text" | "file" | "data";
  text?: string;
  file?: { bytes?: string; uri?: string; mimeType: string; name?: string };
  data?: unknown;
}

export interface A2AMessage {
  kind: "message";
  messageId: string;
  role: "user" | "agent";
  parts: A2APart[];
  contextId?: string;
  taskId?: string;
}

export interface A2ASkill {
  id: string;
  name: string;
  description: string;
  tags?: string[];
  examples?: string[];
}

export interface A2AAgentCard {
  protocolVersion: string;
  name: string;
  description: string;
  url: string;
  version: string;
  capabilities: { streaming: boolean; pushNotifications: boolean };
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: A2ASkill[];
  securitySchemes?: Record<string, { type: string; name?: string; in?: string }>;
  security?: Array<Record<string, string[]>>;
}

export class A2AClientError extends Error {
  constructor(
    message: string,
    public readonly code?: number,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = "A2AClientError";
  }
}

const DEFAULT_TIMEOUT_MS = 40_000;

/** Fetch the agent card from a base URL. Tries the standard well-known path. */
export async function discoverAgent(baseUrl: string, opts: { timeoutMs?: number } = {}): Promise<A2AAgentCard> {
  const url = `${baseUrl.replace(/\/$/, "")}/.well-known/agent-card.json`;
  let res: Response;
  try {
    res = await fetchWithRetry(url, { method: "GET", headers: { Accept: "application/json" } }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  } catch (err) {
    throw new A2AClientError(`Failed to fetch agent card from ${url}`, undefined, err);
  }
  if (!res.ok) {
    throw new A2AClientError(`Agent card fetch returned HTTP ${res.status}`, res.status);
  }
  const card = (await res.json()) as A2AAgentCard;
  if (!card.protocolVersion || !card.url || !Array.isArray(card.skills)) {
    throw new A2AClientError("Agent card missing required fields (protocolVersion, url, skills)");
  }
  return card;
}

interface SendMessageOptions {
  apiKey?: string;
  agentAssertion?: string; // Ed25519 JWT — sent in the X-Agent-Assertion header
  /** Factory called per-attempt to generate a fresh JWT (new JTI). Preferred over
   *  `agentAssertion` — prevents JTI replay failures when retries reuse a consumed nonce. */
  agentAssertionFactory?: () => string | null;
  contextId?: string;
  timeoutMs?: number;
}

/**
 * Send a text message to an A2A agent's JSON-RPC endpoint and return the
 * agent's response message. For agents that return a Task instead of a
 * Message, only the `kind: "message"` case is currently surfaced — extend
 * when consuming async/long-running agents.
 *
 * Returns:
 *   - text: concatenated text parts (legacy, ergonomic for chat).
 *   - dataParts: raw data parts when the agent emits structured payloads
 *     (A2A v0.3.0 spec — agents can return arbitrary JSON in `kind:"data"`
 *     parts alongside text). Velora uses this for the Empleado→Supervisor
 *     notification decision contract.
 */
export async function sendMessage(
  agentUrl: string,
  text: string,
  opts: SendMessageOptions = {}
): Promise<{ messageId: string; text: string; dataParts: unknown[]; contextId: string | undefined }> {
  const buildHeaders = (): Record<string, string> => {
    const h: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    if (opts.apiKey) h["X-API-Key"] = opts.apiKey;
    // agentAssertionFactory takes precedence — it generates a fresh JWT (new JTI)
    // on every call so that retries don't replay an already-consumed nonce.
    const assertion = opts.agentAssertionFactory
      ? opts.agentAssertionFactory()
      : opts.agentAssertion;
    if (assertion) h["X-Agent-Assertion"] = assertion;
    const tc = traceCtxHeader(); if (tc) h["X-Cloud-Trace-Context"] = tc;
    return h;
  };

  const serializedBody = JSON.stringify({
    jsonrpc: "2.0",
    id: randomUUID(),
    method: "message/send",
    params: {
      message: {
        kind: "message",
        messageId: randomUUID(),
        role: "user",
        parts: [{ kind: "text", text }],
        ...(opts.contextId ? { contextId: opts.contextId } : {}),
      },
    },
  });

  // When an agentAssertionFactory is provided, pass a reinitFactory so that
  // fetchWithRetry regenerates the X-Agent-Assertion header on every attempt.
  // This prevents JTI replay failures when the first attempt aborts mid-flight
  // (the server consumed the JTI before the client got the response).
  const reinitFactory = opts.agentAssertionFactory
    ? () => ({ method: "POST" as const, headers: buildHeaders(), body: serializedBody })
    : undefined;

  let res: Response;
  try {
    res = await fetchWithRetry(
      agentUrl,
      { method: "POST", headers: buildHeaders(), body: serializedBody },
      opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      reinitFactory,
    );
  } catch (err) {
    throw new A2AClientError(`Network error calling ${agentUrl}`, undefined, err);
  }

  if (!res.ok) {
    throw new A2AClientError(`Agent returned HTTP ${res.status}`, res.status);
  }

  const json = (await res.json()) as { result?: unknown; error?: { code: number; message: string; data?: unknown } };

  if (json.error) {
    throw new A2AClientError(`Agent JSON-RPC error: ${json.error.message}`, json.error.code, json.error.data);
  }

  const result = json.result;
  if (!result || typeof result !== "object") {
    throw new A2AClientError("Agent response missing result field");
  }
  const kind = (result as { kind?: unknown }).kind;
  if (kind !== "message") {
    throw new A2AClientError(`Agent returned unsupported result kind: ${String(kind)}`);
  }

  const message = result as A2AMessage;
  const partsArray = message.parts ?? [];
  const textParts = partsArray
    .filter((p) => p.kind === "text" && typeof p.text === "string")
    .map((p) => p.text as string);
  const dataParts = partsArray
    .filter((p) => p.kind === "data")
    .map((p) => p.data);

  return {
    messageId: message.messageId,
    text: textParts.join("\n"),
    dataParts,
    contextId: message.contextId,
  };
}

/**
 * Send a structured params object to an A2A agent's JSON-RPC endpoint.
 * Used by agents (e.g. Andreani) that expect a flat params object instead of
 * the spec `params.message` text envelope. The response shape from those
 * agents is `{ kind:"message", ..., result: <skillResult> }` — we return
 * `text` as a JSON.stringify of `result` so callers get a consistent string.
 */
export async function sendStructured(
  agentUrl: string,
  params: Record<string, unknown>,
  opts: SendMessageOptions = {}
): Promise<{ text: string; dataParts: unknown[] }> {
  const buildHeaders = (): Record<string, string> => {
    const h: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    if (opts.apiKey) h["X-API-Key"] = opts.apiKey;
    const assertion = opts.agentAssertionFactory
      ? opts.agentAssertionFactory()
      : opts.agentAssertion;
    if (assertion) h["X-Agent-Assertion"] = assertion;
    const tc = traceCtxHeader(); if (tc) h["X-Cloud-Trace-Context"] = tc;
    return h;
  };

  const serializedBody = JSON.stringify({
    jsonrpc: "2.0",
    id: randomUUID(),
    method: "message/send",
    params,
  });

  const reinitFactory = opts.agentAssertionFactory
    ? () => ({ method: "POST" as const, headers: buildHeaders(), body: serializedBody })
    : undefined;

  let res: Response;
  try {
    res = await fetchWithRetry(
      agentUrl,
      { method: "POST", headers: buildHeaders(), body: serializedBody },
      opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      reinitFactory,
    );
  } catch (err) {
    throw new A2AClientError(`Network error calling ${agentUrl}`, undefined, err);
  }

  if (!res.ok) {
    throw new A2AClientError(`Agent returned HTTP ${res.status}`, res.status);
  }

  const json = (await res.json()) as { result?: unknown; error?: { code: number; message: string; data?: unknown } };

  if (json.error) {
    throw new A2AClientError(`Agent JSON-RPC error: ${json.error.message}`, json.error.code, json.error.data);
  }

  const result = json.result;
  if (!result || typeof result !== "object") {
    throw new A2AClientError("Agent response missing result field");
  }

  // For structured responses, `result` is the full response object.
  // Extract text parts if present; otherwise JSON.stringify the inner `result`
  // field (Andreani returns { kind:"message", ..., result: <skillResult> }).
  const resultObj = result as Record<string, unknown>;
  const partsArray = Array.isArray(resultObj.parts) ? (resultObj.parts as A2APart[]) : [];
  const textParts = partsArray
    .filter((p) => p.kind === "text" && typeof p.text === "string")
    .map((p) => p.text as string);
  const dataParts = partsArray
    .filter((p) => p.kind === "data")
    .map((p) => p.data);

  const text = textParts.length > 0
    ? textParts.join("\n")
    : JSON.stringify(resultObj.result ?? result);

  return { text, dataParts };
}

/**
 * Convenience: discover + send in one call. Resolves the agent card first
 * (so its declared `url` is the source of truth, not a hardcoded path).
 */
export async function callAgent(
  baseUrl: string,
  text: string,
  opts: SendMessageOptions = {}
): Promise<{ agentName: string; messageId: string; text: string; contextId: string | undefined }> {
  const card = await discoverAgent(baseUrl, { timeoutMs: opts.timeoutMs });
  const reply = await sendMessage(card.url, text, opts);
  return { agentName: card.name, ...reply };
}
