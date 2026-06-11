// src/app/api/mcp/route.ts — MCP Streamable HTTP route handler.
//
// Exposes the Velora fiscal MCP server at /api/mcp — the canonical URI advertised
// by the protected-resource metadata, llms.txt, and the public /tools page. The
// handler is transport-agnostic (the SDK transport dispatches the same regardless).
//
// Auth gate (DUAL — additive, not breaking):
//
//   Path A — HMAC (Claude Code / server-to-server):
//     X-API-Key + X-Business-Id headers, HMAC-SHA256(A2A_SECRET, businessId).
//     This path is UNCHANGED — existing Claude Code integrations keep working.
//
//   Path B — OAuth 2.1 Bearer (hosted Claude clients: Cowork / Desktop / claude.ai):
//     Authorization: Bearer <WorkOS JWT>
//     Token validated: signature (JWKS) + iss + aud (RFC 8707) + exp.
//     businessId resolved from the verified email claim → User → Business lookup.
//     Fail-closed: if WorkOS env vars are unset, Bearer returns 401.
//
//   If neither path succeeds → 401 with WWW-Authenticate header (RFC 9728 §5.1).
//   The WWW-Authenticate header points at the protected-resource metadata endpoint
//   so MCP clients can discover the Authorization Server automatically.
//
// Origin validation (DNS-rebinding guard from the MCP spec) is omitted: this
// endpoint is server-to-server only (HMAC-gated or OAuth-gated); no browser-
// originated calls.
//
// Transport: WebStandardStreamableHTTPServerTransport in stateless mode
// (sessionIdGenerator omitted). Stateless is correct here because:
//   1. Both tools are pure functions with no server-side state.
//   2. Cloud Run scales horizontally — in-memory session maps would shard.
//   3. MCP spec 2025-11-05 explicitly supports stateless operation.
//
// References:
//   MCP TypeScript SDK 1.29.0 — WebStandardStreamableHTTPServerTransport
//   MCP Streamable HTTP spec — modelcontextprotocol.io/specification/2025-11-05/
//   MCP Authorization spec — modelcontextprotocol.io/specification/2025-06-18/basic/authorization
//   RFC 9728 §5.1 — WWW-Authenticate response

import { NextRequest, NextResponse } from "next/server";
import { gzipSync } from "node:zlib";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { verifyA2AApiKeyForTenant } from "@/app/api/agents/_lib/a2a-auth";
import { reportWarning } from "@/lib/cloud-logger";
import { buildVeloraMcpServer } from "@/lib/mcp/server";
import { verifyBearerToken, MCP_RESOURCE_URI } from "@/lib/mcp/oauth-verify";

// ── Per-tenant (per-key) rate limiter ────────────────────────────────────────
// Same 60/min-per-tenant intent as the A2A route, but a self-contained in-memory
// sliding window (the A2A route uses the DB-backed checkRateLimitAsync; this route
// stays stateless/in-process). Defense against unbounded SMS/email fan-out via MCP.
// Applied AFTER auth resolves businessId — unauthenticated requests are rejected
// at the auth gate before reaching this limiter.
const MCP_RATE_MAX = 60;
const MCP_RATE_WINDOW_MS = 60_000;
const MCP_RATE_MAX_KEYS = 1_000;
const mcpRateMap = new Map<string, number[]>();

function checkMcpRateLimit(businessId: string): boolean {
  const now = Date.now();
  const cutoff = now - MCP_RATE_WINDOW_MS;

  // Opportunistic prune at hard cap (cheap; only when full).
  if (mcpRateMap.size > MCP_RATE_MAX_KEYS) {
    for (const [key, timestamps] of mcpRateMap) {
      if (timestamps.length === 0 || timestamps[timestamps.length - 1] <= cutoff) {
        mcpRateMap.delete(key);
      }
    }
  }

  const timestamps = mcpRateMap.get(businessId) ?? [];
  const recent = timestamps.filter((t) => t > cutoff);
  recent.push(now);
  mcpRateMap.set(businessId, recent);
  return recent.length <= MCP_RATE_MAX;
}

// ── Auth gate ─────────────────────────────────────────────────────────────────

// WWW-Authenticate header value per RFC 9728 §5.1.
// Points at the protected-resource metadata endpoint so MCP clients can
// discover the Authorization Server and start the OAuth flow.
// Build the metadata pointer from MCP_RESOURCE_URI (single source of truth).
// RFC 9728 §3.1: when the resource identifier has a path, the well-known segment
// is inserted BETWEEN the host and the path — so the pointer matches what
// path-aware clients (Cowork) construct from the resource identifier:
//   https://tools.somosvelora.com/.well-known/oauth-protected-resource/api/mcp
// Deriving from the origin alone (bare path) made clients 404 their discovery.
const _resourceUrl = new URL(MCP_RESOURCE_URI);
const PROTECTED_RESOURCE_METADATA_URL = `${_resourceUrl.origin}/.well-known/oauth-protected-resource${_resourceUrl.pathname}`;

const WWW_AUTHENTICATE_VALUE = `Bearer resource_metadata="${PROTECTED_RESOURCE_METADATA_URL}"`;

function unauthorizedResponse(
  code = "UNAUTHORIZED",
  message = "Unauthorized.",
  includeWwwAuth = true,
): NextResponse {
  // Structured error shape per api-standards Rule 3 ({ code, message }) — the
  // [RESP] guardrail applies to every route, including AUTH_EXEMPT ones.
  const headers: Record<string, string> = {};
  if (includeWwwAuth) {
    // RFC 9728 §5.1: 401 responses MUST include WWW-Authenticate with the
    // resource_metadata URI so clients can discover the authorization server.
    headers["WWW-Authenticate"] = WWW_AUTHENTICATE_VALUE;
  }
  return NextResponse.json({ code, message }, { status: 401, headers });
}

function forbiddenResponse(code: string, message: string): NextResponse {
  return NextResponse.json({ code, message }, { status: 403 });
}

// ── Dual auth resolver ────────────────────────────────────────────────────────
// Try HMAC first (cheap, no network). If that fails AND a Bearer header is
// present, try OAuth. If neither succeeds → 401 with WWW-Authenticate.

type AuthResult =
  | { ok: true; businessId: string }
  | { ok: false; response: NextResponse };

async function resolveAuth(req: NextRequest): Promise<AuthResult> {
  // ── Path A: HMAC (Claude Code / server-to-server) ─────────────────────────
  const xApiKey = req.headers.get("x-api-key");
  const xBusinessId = req.headers.get("x-business-id");
  // verifyA2AApiKeyForTenant already rejects null businessId at the checkA2AApiKey boundary
  // (!businessId → false). The `|| !xBusinessId` arm is kept for TypeScript type narrowing:
  // it ensures xBusinessId is `string` (not `string | null`) in the success branch.
  if (verifyA2AApiKeyForTenant(xApiKey, xBusinessId) && xBusinessId) {
    return { ok: true, businessId: xBusinessId };
  }

  // ── Path B: OAuth 2.1 Bearer (hosted MCP clients) ─────────────────────────
  const authHeader = req.headers.get("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    const result = await verifyBearerToken(authHeader);
    if (result.ok) {
      return { ok: true, businessId: result.businessId };
    }
    // Return the appropriate HTTP status from the Bearer verifier.
    if (result.status === 500) {
      // Genuine server error during provisioning — 500, no WWW-Authenticate.
      return {
        ok: false,
        response: NextResponse.json(
          { code: result.code, message: result.message },
          { status: 500 },
        ),
      };
    }
    if (result.status === 403) {
      return { ok: false, response: forbiddenResponse(result.code, result.message) };
    }
    // 401 — include WWW-Authenticate per RFC 9728 §5.1.
    return {
      ok: false,
      response: unauthorizedResponse(result.code, result.message, true),
    };
  }

  // ── Neither path succeeded → 401 with WWW-Authenticate ───────────────────
  return { ok: false, response: unauthorizedResponse() };
}

// ── Gzip compression helper ───────────────────────────────────────────────────
// MCP widget resources (resources/read) return ~535KB of self-contained HTML+JS.
// Cloud Run's Google Frontend does NOT auto-compress API responses (only static
// assets go through GFE's compression pipeline). Next.js standalone mode also
// strips the built-in compression middleware. We apply gzip at the app layer.
//
// Threshold: 10KB — below that, compression overhead exceeds the gain.
// Only applied when the client advertises Accept-Encoding: gzip (RFC 7231 §5.3.4).
// The widget bundle compresses ~77% (535KB → ~125KB at level 6).
//
// References:
//   RFC 7231 §3.1.2.2 — Content-Encoding
//   RFC 7232 §3.5 — Accept-Encoding negotiation
//   Node.js zlib docs — gzipSync (synchronous, safe for route handlers < 600KB)
const GZIP_THRESHOLD_BYTES = 10_240;

async function maybeGzip(res: Response, req: NextRequest): Promise<Response> {
  const acceptEncoding = req.headers.get("accept-encoding") ?? "";
  if (!acceptEncoding.includes("gzip")) return res;

  // Only compress JSON responses (MCP protocol delivers everything as JSON).
  const ct = res.headers.get("content-type") ?? "";
  if (!ct.includes("application/json") && !ct.includes("text/event-stream")) return res;

  const buf = await res.arrayBuffer();
  if (buf.byteLength < GZIP_THRESHOLD_BYTES) return new Response(buf, res);

  const compressed = gzipSync(Buffer.from(buf), { level: 6 });
  const headers = new Headers(res.headers);
  headers.set("Content-Encoding", "gzip");
  headers.set("Content-Length", String(compressed.byteLength));
  headers.set("Vary", "Accept-Encoding");
  return new Response(compressed, { status: res.status, statusText: res.statusText, headers });
}

// ── Handler ───────────────────────────────────────────────────────────────────

async function handleMcpRequest(req: NextRequest): Promise<Response> {
  const auth = await resolveAuth(req);
  if (!auth.ok) return auth.response;

  // Per-tenant rate limit — enforced after auth resolves businessId.
  // Mirrors the A2A route pattern: 60 req/min per key, in-memory sliding window.
  if (!checkMcpRateLimit(auth.businessId)) {
    reportWarning("MCP per-tenant rate limit hit", { scope: "mcp.rate-limit-tenant", businessId: auth.businessId });
    return NextResponse.json(
      { code: "RATE_LIMIT_EXCEEDED", message: "Rate limit exceeded for this tenant. Retry after 60 seconds." },
      { status: 429, headers: { "Retry-After": "60" } },
    );
  }

  // A fresh server + transport per request: correct for stateless mode.
  // McpServer holds no per-session state; transport handles the HTTP
  // request/response lifecycle and closes itself when done.
  // Pass businessId so stateful fiscal tools (get_fiscal_readiness, emit_invoice)
  // are registered for the verified tenant.
  // Toolset selection (GitHub/Stripe MCP pattern): ?packs=payments,catalog loads ONLY
  // those packs (fewer tools per connection → fewer tokens). Omit to load all packs.
  // Pure tools (validate_cuit) always load. Configure per-connector by appending the
  // query to the MCP URL: https://tools.somosvelora.com/api/mcp?packs=payments
  const packsParam = req.nextUrl.searchParams.get("packs");
  const packs = packsParam
    ? packsParam.split(",").map((p) => p.trim().toLowerCase()).filter(Boolean)
    : undefined;
  const server = await buildVeloraMcpServer(auth.businessId, packs);
  const transport = new WebStandardStreamableHTTPServerTransport({
    // sessionIdGenerator omitted → stateless mode (no session header emitted,
    // no session validation performed — per SDK docs).
    enableJsonResponse: true,
  });

  await server.connect(transport);
  // handleRequest returns a Web Standard Response — compatible with Next.js
  // App Router route handlers (which accept Response, not just NextResponse).
  const raw = await transport.handleRequest(req);
  return maybeGzip(raw, req);
}

// ── Route exports (GET + POST — MCP Streamable HTTP uses both) ────────────────

export async function GET(req: NextRequest): Promise<Response> {
  return handleMcpRequest(req);
}

export async function POST(req: NextRequest): Promise<Response> {
  return handleMcpRequest(req);
}

// DELETE is part of the MCP Streamable HTTP spec for session termination.
// In stateless mode the transport handles it gracefully (405 or no-op),
// but we export the handler for spec compliance.
export async function DELETE(req: NextRequest): Promise<Response> {
  return handleMcpRequest(req);
}
