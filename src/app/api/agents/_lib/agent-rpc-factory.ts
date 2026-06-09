// agent-rpc-factory.ts — Reusable A2A JSON-RPC route handler factory.
//
// Every Velora sub-agent RPC route (Fiscal, Payments, Equipo, Logística,
// Ventas, future Comunicaciones…) duplicates the same 60-line scaffold:
//   1. Parse body
//   2. Extract businessId from A2A text payload
//   3. Verify X-API-Key (per-tenant HMAC)
//   4. Verify X-Agent-Assertion JWT (Ed25519)
//   5. Rate-limit (per-tenant key)
//   6. Dispatch to agent handler
//   7. Catch + log errors
//
// createAgentRpcRoute() encapsulates steps 1-5 and 7. Step 6 (dispatch) is
// passed as the `handle` callback — it contains agent-specific logic.
//
// USAGE (new Communications agent):
//
//   export const POST = createAgentRpcRoute({
//     agentName: "comunicaciones",
//     callerIdentity: "supervisor",
//     rateLimit: { bucket: "comunicaciones-a2a", max: 20, windowSec: 60 },
//     handle: async (body, ctx) => handleComunicacionesRpc(body, ctx),
//   });
//
// MULTI-ISSUER agents (Logística accepts Payments + Supervisor):
//
//   export const POST = createAgentRpcRoute({
//     agentName: "logistica",
//     callerIdentity: ["payments", "supervisor"],
//     rateLimit: { bucket: "logistica-a2a", max: 20, windowSec: 60 },
//     handle: async (body, ctx) => handleLogisticaRpc(body, ctx),
//   });

import { NextRequest, NextResponse } from "next/server";
import { runWithTraceContext } from "@/lib/cloud-logger";
import { checkRateLimitAsync, logRouteError } from "@/app/api/_lib/route-helpers";
import { verifyA2AApiKeyForTenant } from "@/app/api/agents/_lib/a2a-auth";
import { verifyAgentAssertionMulti, type AgentId } from "@/lib/agent-identity";
import {
  rpcError,
  RPC_ERRORS,
  extractTextFromParams,
  extractBusinessIdFromText,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "@velora/core-utils/jsonrpc-types";

// ── Public API ────────────────────────────────────────────────────────────────

export interface AgentRpcContext {
  businessId: string | null;
}

export interface AgentRpcRateLimitConfig {
  /** Unique bucket name for this agent (e.g. "comunicaciones-a2a"). */
  bucket: string;
  /** Max requests allowed in the window per businessId. Default: 20. */
  max?: number;
  /** Window duration in seconds. Default: 60. */
  windowSec?: number;
}

export interface CreateAgentRpcRouteOptions {
  /**
   * This agent's AgentId — used in X-Agent-Assertion audience verification
   * and error log labels. Must be a registered AgentId value.
   * New agents must be added to the AgentId union in agent-identity.ts first.
   */
  agentName: AgentId;
  /**
   * Identity of the expected caller(s) — must be registered AgentId values.
   * Single issuer or array for multi-issuer agents (e.g. ["payments", "supervisor"]).
   * The factory verifies at least ONE issuer matches (short-circuit OR).
   */
  callerIdentity: AgentId | AgentId[];
  /** Per-tenant rate limit config. */
  rateLimit: AgentRpcRateLimitConfig;
  /**
   * Agent-specific dispatch function.
   * Receives the validated JSON-RPC body and the resolved context.
   * Must return a JsonRpcResponse.
   */
  handle: (body: JsonRpcRequest, ctx: AgentRpcContext) => Promise<JsonRpcResponse>;
  /**
   * Optional: max route duration in seconds (for Next.js / Vercel).
   * Cloud Run ignores this — it's a Next.js route segment config.
   * Set on the exported route constant, not here.
   */
}

/**
 * Returns a Next.js POST route handler with full A2A auth + rate-limit scaffold.
 *
 * The returned function is a NextRequest → NextResponse handler ready to be
 * exported as `export const POST = createAgentRpcRoute({...})`.
 */
export function createAgentRpcRoute(
  opts: CreateAgentRpcRouteOptions,
): (req: NextRequest) => Promise<NextResponse> {
  const { agentName, callerIdentity, rateLimit, handle } = opts;
  const callers = Array.isArray(callerIdentity) ? callerIdentity : [callerIdentity];
  const { bucket, max = 20, windowSec = 60 } = rateLimit;

  const json = (body: unknown, status = 200): NextResponse =>
    NextResponse.json(body, { status });

  async function handlePost(req: NextRequest): Promise<NextResponse> {
    // Step 1: Parse body — must happen before auth so we can extract businessId
    // for per-tenant key derivation.
    let body: JsonRpcRequest;
    try {
      body = (await req.json()) as JsonRpcRequest;
    } catch {
      return json(rpcError(null, RPC_ERRORS.PARSE_ERROR));
    }

    // Step 2: Extract businessId from the incoming params.
    //
    // Two call shapes arrive at this factory:
    //   a) Spec-compliant A2A envelope (Supervisor → all agents):
    //      params.message.parts[].text embeds "businessId: <id>" on its own line.
    //      extractTextFromParams + extractBusinessIdFromText handles this.
    //   b) Flat structured params (Payments → Logística via sendStructured):
    //      params is a plain object { skill, businessId, ... } with no message
    //      envelope. extractTextFromParams returns null here, so we fall back to
    //      reading params.businessId directly.
    //
    // CUID shape: 25 lowercase alphanumeric chars; allow 20-30 for tolerance.
    // Underscores allowed: test fixtures and prefixed IDs (e.g. "biz_<hex>") use
    // underscore separators. The HMAC key check (Step 3) is the real security
    // gate; this regex only guards against namespace-injection via non-printable
    // or path-traversal chars. Ref: extract-businessId comment in jsonrpc-types.ts.
    const rawText = extractTextFromParams(body.params);
    const rawBusinessId = rawText
      ? extractBusinessIdFromText(rawText)
      : (body.params as { businessId?: unknown } | null)?.businessId as string | null ?? null;
    const businessId =
      typeof rawBusinessId === "string" && /^[a-z0-9_]{20,30}$/.test(rawBusinessId)
        ? rawBusinessId
        : null;

    // Step 3: Verify per-tenant X-API-Key (HMAC-SHA256 derived from A2A_SECRET + businessId).
    const xApiKey = req.headers.get("x-api-key");
    if (!verifyA2AApiKeyForTenant(xApiKey, businessId)) {
      return json(
        rpcError(null, RPC_ERRORS.AUTH_REQUIRED, "Missing or invalid X-API-Key header"),
      );
    }

    // Step 4: Verify X-Agent-Assertion JWT (Ed25519).
    // Multi-issuer agents (e.g. Logística accepts ["payments", "supervisor"]) use
    // verifyAgentAssertionMulti, which tries candidates in silent mode and emits
    // a single consolidated log only when ALL candidates fail (collect-then-decide).
    // This eliminates spurious ASSERTION_WRONG_ISSUER WARNINGs on every legitimate
    // cross-issuer call (e.g. Supervisor→Logística failing the "payments" candidate
    // before succeeding on "supervisor"). Pattern: IAM canonical multi-candidate
    // verification. Ref: cloud.google.com/iam/docs/reference/credentials/rest (2026).
    const assertion = req.headers.get("x-agent-assertion");
    const assertionOk = await verifyAgentAssertionMulti(assertion, callers, agentName);
    if (!assertionOk) {
      return json(
        rpcError(null, RPC_ERRORS.AUTH_REQUIRED, "Invalid or expired X-Agent-Assertion"),
      );
    }

    // Step 5: Rate-limit AFTER auth so we key by businessId, not IP.
    // Internal Cloud Run self-calls share the same egress IP, making IP-based
    // buckets collapse all businesses into a single counter.
    // A2A sync: await the async DB token-bucket so the result is respected before
    // dispatching to the agent handler (fire-and-forget would silently pass through).
    const rateLimited = await checkRateLimitAsync(req, bucket, max, windowSec, {
      actorKey: businessId ?? "unknown",
    });
    if (rateLimited) return rateLimited;

    // Step 6: Dispatch to agent-specific handler.
    try {
      const response = await handle(body, { businessId });
      return json(response);
    } catch (error) {
      // Step 7: Catch + log with structured label.
      logRouteError(`agents.${agentName}.jsonrpc`, error, {
        method: typeof body.method === "string" ? body.method : "unknown",
      });
      return json(rpcError(body?.id, RPC_ERRORS.INTERNAL_ERROR));
    }
  }

  return (req: NextRequest) => runWithTraceContext(req.headers, () => handlePost(req));
}
