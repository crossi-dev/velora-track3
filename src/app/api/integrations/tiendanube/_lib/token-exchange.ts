// Wrapper sobre el token exchange endpoint de Tienda Nube.
// Espejo exacto de mp/_lib/token-exchange.ts — isolado para facilitar stub en tests.
//
// Source: tiendanube.github.io/api-documentation/authentication
//   POST https://www.tiendanube.com/apps/authorize/token
//   Content-Type: application/json
//   body: { client_id, client_secret, grant_type: "authorization_code", code }
//
//   Response: { access_token, token_type, scope, user_id }
//   user_id IS the store_id.

import { cloudLog } from "@/lib/cloud-logger";
import { TN_TOKEN_ENDPOINT } from "./config";

const HTTP_TIMEOUT_MS = 8_000;

// Sensitive keys — redacted from diagnostic logs.
const SENSITIVE_KEYS = new Set(["access_token", "client_secret"]);

function safeSnippet(rawText: string, parsed: unknown): string {
  if (parsed && typeof parsed === "object") {
    const redacted: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      redacted[k] = SENSITIVE_KEYS.has(k) ? "<redacted>" : v;
    }
    return JSON.stringify(redacted).slice(0, 300);
  }
  return rawText.slice(0, 200);
}

function describeShape(parsed: unknown): Record<string, string> | string {
  if (parsed === null || parsed === undefined) return "<null-or-undefined>";
  if (typeof parsed !== "object") return `<${typeof parsed}>`;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (v === null) out[k] = "null";
    else if (Array.isArray(v)) out[k] = `array[${v.length}]`;
    else out[k] = typeof v;
  }
  return out;
}

export interface TiendanubeTokenResponse {
  access_token: string;
  token_type: string;
  scope: string;
  /** Numeric store ID — user_id IS the store_id per TN docs. */
  user_id: number | string;
}

function isTiendanubeTokenResponse(value: unknown): value is TiendanubeTokenResponse {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.access_token === "string" &&
    (typeof v.user_id === "number" || typeof v.user_id === "string")
  );
}

function extractErrorMessage(parsed: unknown): string {
  if (parsed && typeof parsed === "object") {
    const v = parsed as Record<string, unknown>;
    if (typeof v.error === "string") return v.error;
    if (typeof v.message === "string") return v.message;
    if (typeof v.error_description === "string") return v.error_description;
  }
  return "tn_token_endpoint_error";
}

export type TiendanubeTokenExchangeResult =
  | { ok: true; accessToken: string; storeId: string }
  | { ok: false; status: number; error: string };

interface ExchangeTiendanubeCodeArgs {
  clientId: string;
  clientSecret: string;
  code: string;
  // Override fetch in tests to avoid hitting the real API.
  fetchImpl?: typeof fetch;
}

/**
 * Exchanges an authorization code for an access_token + store_id.
 * Returns { accessToken, storeId } on success; normalises storeId to string.
 * Redacts secrets from all log output.
 */
export async function exchangeTiendanubeCode(
  args: ExchangeTiendanubeCodeArgs,
): Promise<TiendanubeTokenExchangeResult> {
  const fetchFn = args.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchFn(TN_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_id: args.clientId,
        client_secret: args.clientSecret,
        grant_type: "authorization_code",
        code: args.code,
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  const contentType = response.headers.get("content-type") ?? "<none>";
  const rawText = await response.text();
  let parsed: unknown = null;
  let parseError: string | null = null;
  try {
    parsed = rawText ? JSON.parse(rawText) : null;
  } catch (err) {
    parseError = err instanceof Error ? err.message : String(err);
  }

  if (!response.ok || !isTiendanubeTokenResponse(parsed)) {
    cloudLog({
      severity: "ERROR",
      component: "System",
      action: "TN_TOKEN_EXCHANGE_REJECTED",
      a2a_transfer: false,
      message: `TN token exchange rejected: httpStatus=${response.status} contentType=${contentType} parseError=${parseError ?? "none"}`,
      data: {
        httpStatus: response.status,
        contentType,
        parseError,
        bodyLength: rawText.length,
        bodySnippet: safeSnippet(rawText, parsed),
        shape: describeShape(parsed),
      },
    });
    return { ok: false, status: response.status, error: extractErrorMessage(parsed) };
  }

  // user_id IS the store_id per TN docs — normalise to string.
  const storeId = String((parsed as TiendanubeTokenResponse).user_id);
  return { ok: true, accessToken: parsed.access_token, storeId };
}
