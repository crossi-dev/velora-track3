// Pure JSON-RPC handling for the A2A endpoint. Decoupled from next/server
// so it can be unit-tested in plain Node without the Next.js runtime.
//
// The route at /api/a2a/jsonrpc wraps this with NextRequest/NextResponse
// + Cloud Error Reporting + rate limiting.

import { createHmac, randomUUID, timingSafeEqual } from "crypto";
import {
  RPC_ERRORS,
  rpcError as _rpcError,
  rpcResult as _rpcResult,
  extractTextFromParams as _extractTextFromParams,
  extractContextIdFromParams as _extractContextIdFromParams,
  extractBusinessIdFromText as _extractBusinessIdFromText,
  A2A_MAX_INPUT_CHARS as _A2A_MAX_INPUT_CHARS,
  type JsonRpcRequest as _JsonRpcRequest,
  type JsonRpcErrorBody as _JsonRpcErrorBody,
  type JsonRpcResultBody as _JsonRpcResultBody,
  type JsonRpcResponse as _JsonRpcResponse,
  type A2APart,
} from "@/lib/a2a/jsonrpc-types";

// ── Types local to this endpoint ─────────────────────────────────────────────

export interface A2AMessageReply {
  kind: "message";
  messageId: string;
  role: "agent";
  parts: A2APart[];
  contextId?: string;
}

/**
 * Result returned by a supervisor adapter. Either a plain string (legacy)
 * or a structured object that includes both human-readable text and
 * arbitrary data (e.g. for threshold notification decisions consumed by
 * server-side callers via A2A loopback).
 */
export type SupervisorAdapterResult = string | { text: string; data?: unknown };

// Re-export canonical types and helpers so the route can continue to import
// them from this module without changes. The local redeclarations are removed.
export type JsonRpcRequest = _JsonRpcRequest;
export type JsonRpcErrorBody = _JsonRpcErrorBody;
export type JsonRpcResultBody = _JsonRpcResultBody;
export type JsonRpcResponse = _JsonRpcResponse;

// JSON_RPC_ERRORS is the legacy export name used by route.ts. It is an alias
// for the canonical RPC_ERRORS — identical codes and messages.
// The local copy had RATE_LIMIT_EXCEEDED; canonical has RATE_LIMIT (same code,
// -32005). The local key was never referenced outside this file.
export { RPC_ERRORS as JSON_RPC_ERRORS };

export { _rpcError as rpcError, _rpcResult as rpcResult };

// A2A_MAX_INPUT_CHARS: canonical value is 4_000, same as the local 4000.
export { _A2A_MAX_INPUT_CHARS as A2A_MAX_INPUT_CHARS };

// extractContextIdFromParams: canonical implementation is identical to the
// local one (trim + non-empty string check on contextId).
export { _extractContextIdFromParams as extractContextIdFromParams };

// extractBusinessIdFromText: delegates to canonical \S+ capture (stricter
// than the old local greedy (.+) that could capture trailing prose).
export { _extractBusinessIdFromText as extractBusinessIdFromText };

// extractTextFromParams: canonical adds a typeof .text === "string" type-guard
// on text parts that the local version omitted — behavior-compatible (any
// non-string text part would have produced a type error at runtime regardless).
export { _extractTextFromParams as extractTextFromParams };

/**
 * Core JSON-RPC dispatcher. Pure function — takes a parsed body + a
 * supervisor function, returns the JSON-RPC response shape. The route
 * wrapper handles NextResponse/rate-limit/auth.
 *
 * supervisorFn puede retornar:
 *   - string: legacy, solo text part en el reply
 *   - { text, data? }: text part + opcional data part. Lo usan los
 *     consumers server-side (loopback Empleado→Supervisor) que necesitan
 *     leer la decisión estructurada de notificación.
 */
export async function handleA2ARpc(
  body: _JsonRpcRequest,
  supervisorFn: (text: string) => Promise<SupervisorAdapterResult>
): Promise<_JsonRpcResponse> {
  if (!body || body.jsonrpc !== "2.0" || typeof body.method !== "string") {
    return _rpcError(body?.id, RPC_ERRORS.INVALID_REQUEST);
  }

  switch (body.method) {
    case "message/send": {
      const text = _extractTextFromParams(body.params);
      if (!text) {
        return _rpcError(body.id, RPC_ERRORS.INVALID_PARAMS, "message.parts must contain at least one text part");
      }
      const adapterResult = await supervisorFn(text);
      const responseText = typeof adapterResult === "string" ? adapterResult : adapterResult.text;
      const responseData = typeof adapterResult === "string" ? undefined : adapterResult.data;
      const parts: A2APart[] = [{ kind: "text", text: responseText }];
      if (responseData !== undefined) {
        parts.push({ kind: "data", data: responseData });
      }
      // Echo the request contextId to preserve multi-turn threading per A2A v0.3.0 spec.
      const replyContextId = _extractContextIdFromParams(body.params) ?? randomUUID();
      const reply: A2AMessageReply = {
        kind: "message",
        messageId: randomUUID(),
        role: "agent",
        parts,
        contextId: replyContextId,
      };
      return _rpcResult(body.id, reply);
    }

    // Velora returns Messages synchronously, never Tasks. Spec compliance:
    // accept the methods, report task-not-found.
    case "tasks/get":
    case "tasks/cancel":
      return _rpcError(body.id, RPC_ERRORS.TASK_NOT_FOUND);

    default:
      return _rpcError(body.id, RPC_ERRORS.METHOD_NOT_FOUND);
  }
}

/**
 * Constant-time string comparison using Node's crypto.timingSafeEqual.
 * The previous loop bailed early on length mismatch, leaking key length via timing.
 * timingSafeEqual throws on length mismatch; we catch and return false (constant-time at API level).
 * Ref: nodejs.org/api/crypto.html#cryptotimingsafeequala-b (Node.js 2026)
 */
function constantTimeEqual(a: string, b: string): boolean {
  try {
    return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
  } catch {
    return false;
  }
}

/**
 * Derives a per-tenant API key: HMAC-SHA256(A2A_SECRET, "v1:" + businessId).
 * The "v1:" prefix allows future rotation without changing the secret — bump to "v2:"
 * and accept both during a transition window.
 */
export function deriveA2AKey(secret: string, businessId: string): string {
  return createHmac("sha256", secret).update(`v1:${businessId}`, "utf8").digest("base64url");
}

/**
 * Validate an A2A API key using HMAC binding.
 *
 * Accepts only the "v1:" derivation (deriveA2AKey). The legacy bare-businessId
 * derivation (pre-B12) was removed after 24h of zero A2A_KEY_LEGACY_DERIVATION_ACCEPTED
 * log events confirmed no callers remained on the old scheme (verified 2026-05-30).
 *
 * Requires both A2A_SECRET and businessId. Returns false if either is absent —
 * there is no global/anonymous key fallback. Every authenticated A2A call must
 * identify a tenant and prove it holds the key derived for that tenant.
 */
export function checkA2AApiKey(
  provided: string | null,
  secret: string | undefined,
  businessId?: string | null,
  log?: (msg: string, data: Record<string, unknown>) => void,
): boolean {
  if (!provided || !secret || !businessId) return false;
  void log; // reserved for future audit logging

  const expected = deriveA2AKey(secret, businessId);
  return constantTimeEqual(provided, expected);
}
