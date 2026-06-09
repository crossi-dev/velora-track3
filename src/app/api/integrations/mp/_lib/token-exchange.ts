// Wrapper sobre el endpoint de token exchange + refresh de Mercado Pago.
// Aislado en un sibling para que las routes (connect/callback/disconnect)
// no conozcan el shape exacto del fetch — facilita stub en tests.

import { cloudLog } from "@/lib/cloud-logger";
import {
  MP_TOKEN_ENDPOINT,
  isMpTokenResponse,
  type MpTokenResponse,
} from "./config";

// Build a safe shape descriptor of an MP response body — keys + value types,
// never the values themselves (tokens are sensitive). Used when the type guard
// rejects a 200 OK response so we can diagnose why without leaking secrets.
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

// Sanitize a raw body snippet for logging. If the body parsed to JSON,
// redact known sensitive token fields (access_token, refresh_token,
// public_key). For non-JSON bodies (HTML error pages, etc.) return as-is —
// they cannot contain tokens.
const SENSITIVE_KEYS = new Set(["access_token", "refresh_token", "public_key", "client_secret"]);
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

export type TokenExchangeResult =
  | { ok: true; tokens: MpTokenResponse }
  | { ok: false; status: number; error: string };

interface ExchangeAuthorizationCodeArgs {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  // Override fetch en tests para no pegarle a la API real.
  fetchImpl?: typeof fetch;
}

const HTTP_TIMEOUT_MS = 8_000;

export async function exchangeAuthorizationCode(
  args: ExchangeAuthorizationCodeArgs,
): Promise<TokenExchangeResult> {
  const fetchFn = args.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  let response: Response;
  try {
    // RFC 6749 §4.1.3 — token endpoint requires application/x-www-form-urlencoded
    response = await fetchFn(MP_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: args.clientId,
        client_secret: args.clientSecret,
        code: args.code,
        grant_type: "authorization_code",
        redirect_uri: args.redirectUri,
      }).toString(),
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

  if (!response.ok || !isMpTokenResponse(parsed)) {
    // Sanitized diagnostic log — emit the SHAPE of MP's response (keys + value
    // types only, never values) so we can debug why the guard rejected a 200.
    cloudLog({
      severity: "ERROR",
      component: "System",
      action: "MP_TOKEN_EXCHANGE_REJECTED_SHAPE",
      a2a_transfer: false,
      message: `MP token exchange rejected: httpStatus=${response.status} contentType=${contentType} parseError=${parseError ?? "none"}`,
      data: {
        httpStatus: response.status,
        contentType,
        parseError,
        bodyLength: rawText.length,
        bodySnippet: safeSnippet(rawText, parsed),
        shape: describeShape(parsed),
      },
    });
    return {
      ok: false,
      status: response.status,
      error: extractErrorMessage(parsed),
    };
  }
  return { ok: true, tokens: parsed };
}

interface RefreshAccessTokenArgs {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  fetchImpl?: typeof fetch;
}

export async function refreshAccessToken(
  args: RefreshAccessTokenArgs,
): Promise<TokenExchangeResult> {
  const fetchFn = args.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  let response: Response;
  try {
    // RFC 6749 §6 — refresh token requests also require form-urlencoded
    response = await fetchFn(MP_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: args.clientId,
        client_secret: args.clientSecret,
        refresh_token: args.refreshToken,
        grant_type: "refresh_token",
      }).toString(),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  let parsed: unknown = null;
  try {
    parsed = await response.json();
  } catch {
    parsed = null;
  }

  if (!response.ok || !isMpTokenResponse(parsed)) {
    return {
      ok: false,
      status: response.status,
      error: extractErrorMessage(parsed),
    };
  }
  return { ok: true, tokens: parsed };
}

function extractErrorMessage(parsed: unknown): string {
  if (parsed && typeof parsed === "object") {
    const v = parsed as Record<string, unknown>;
    if (typeof v.error === "string") return v.error;
    if (typeof v.message === "string") return v.message;
  }
  return "mp_token_endpoint_error";
}
