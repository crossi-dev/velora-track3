// src/lib/mcp/oauth-verify.ts — OAuth 2.1 Bearer token verifier for the MCP resource server.
//
// Velora acts as an OAuth 2.1 Resource Server (RFC 9728). The Authorization Server
// is WorkOS AuthKit (external). This module validates inbound Bearer tokens and
// resolves them to a Velora businessId so the MCP handler can scope tools.
//
// Validation chain (RFC 8707 + OAuth 2.1 §5.2):
//   1. Decode + verify signature against WorkOS JWKS endpoint.
//   2. Verify `iss` matches WORKOS_AS_ISSUER.
//   3. Verify `aud` includes Velora's canonical MCP URI (RFC 8707 audience binding).
//      This is the critical anti-token-reuse check — tokens not bound to us are rejected.
//   4. Verify not expired (`exp`).
//   5. Extract `email` claim → look up Velora User → resolve `businessId`.
//
// Fail-closed: if WorkOS env vars are unset, Bearer auth returns 401 "oauth_not_configured".
// The existing HMAC path (x-api-key + x-business-id) is UNAFFECTED by this module.
//
// Sources (verified 2026-06-01):
//   MCP Authorization spec: modelcontextprotocol.io/specification/2025-06-18/basic/authorization
//   RFC 9728 Protected Resource Metadata: datatracker.ietf.org/doc/html/rfc9728
//   RFC 8707 Resource Indicators: rfc-editor.org/rfc/rfc8707.html
//   WorkOS AuthKit MCP: workos.com/docs/authkit/mcp

import { jwtVerify, createRemoteJWKSet, type JWTVerifyResult } from "jose";
import { prisma } from "@/lib/prisma";
import { reportWarning, cloudLog } from "@/lib/cloud-logger";
import {
  provisionTenantForWorkosUser,
  EmailAlreadyRegisteredError,
} from "@/lib/mcp/_lib/jit-provision-tenant";

// Canonical Velora MCP resource URI — used as the OAuth `aud` claim.
// Must match the `resource` parameter clients send in authorization requests.
// Default matches the production tools subdomain; overridable for staging.
const MCP_RESOURCE_URI =
  process.env.MCP_RESOURCE_URI ?? "https://tools.somosvelora.com/api/mcp";

// ── Result types ──────────────────────────────────────────────────────────────

export type BearerVerifyOk = {
  ok: true;
  businessId: string;
};

export type BearerVerifyError = {
  ok: false;
  status: 401 | 403 | 500;
  code: string;
  message: string;
};

export type BearerVerifyResult = BearerVerifyOk | BearerVerifyError;

// ── JWKS cache (module-level singleton, one per process) ──────────────────────
// createRemoteJWKSet is a factory — calling it multiple times per request would
// refetch keys unnecessarily. A module-level instance caches keys automatically.
// Lazily initialised so a missing WORKOS_JWKS_URL doesn't crash at module load.

let _jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

function getJwks(): ReturnType<typeof createRemoteJWKSet> | null {
  const url = process.env.WORKOS_JWKS_URL;
  if (!url) return null;
  // Recreate only if the URL changed (rare; guards against env hot-reload in dev).
  if (!_jwks) {
    _jwks = createRemoteJWKSet(new URL(url));
  }
  return _jwks;
}

// ── WorkOS user lookup ──────────────────────────────────────────────────────
// WorkOS access tokens intentionally OMIT profile claims — they carry only
// sub/sid/org_id/role/permissions/exp. The documented MCP pattern uses `sub` as
// the user identity and resolves the profile via the Management API. We call
// GET /user_management/users/{sub} with the server API key to obtain email +
// email_verified — independent of the token's scopes, which DCR/CIMD clients do
// not reliably carry. Verified live 2026-06-03.
// Sources: workos.com/docs/authkit/mcp (use payload.sub as identity),
//          workos.com/docs/user-management/sessions/integrating-sessions/access-token
//          (access-token claims list — email is not among them).
//
// PERF FIX (2026-07-26): because `email` is never on the token, this Management
// API call fired on EVERY /api/mcp request from OAuth clients (Claude hosted
// connectors) — confirmed live via Cloud Run logs: every 200/202 response on
// /api/mcp was 3-8s, including bare JSON-RPC notifications, and three requests
// 140ms apart landed on the SAME Cloud Run instanceId at the same latency,
// which rules out cold start. That pointed at a fixed per-request cost paid
// before any tool logic runs — this uncached third-party network round trip
// in the auth gate. A short in-memory TTL cache keyed by `sub` removes it from
// the hot path for any client polling within the window; email/verification
// status changing mid-window is an accepted staleness tradeoff (5 min is well
// under a WorkOS access token's own lifetime, so this never outlives the token
// it was resolved for).

type WorkosUser = { email?: string; email_verified?: boolean };

const WORKOS_USER_CACHE_TTL_MS = 5 * 60 * 1000;
const workosUserCache = new Map<string, { user: WorkosUser | null; expiresAt: number }>();

async function fetchWorkosUser(sub: unknown): Promise<WorkosUser | null> {
  const apiKey = process.env.WORKOS_API_KEY;
  if (!apiKey || typeof sub !== "string" || !sub) return null;

  const cached = workosUserCache.get(sub);
  if (cached && cached.expiresAt > Date.now()) return cached.user;

  const base = process.env.WORKOS_API_BASE_URL ?? "https://api.workos.com";
  let user: WorkosUser | null;
  try {
    const res = await fetch(
      `${base}/user_management/users/${encodeURIComponent(sub)}`,
      { headers: { Authorization: `Bearer ${apiKey}` } },
    );
    user = res.ok ? ((await res.json()) as WorkosUser) : null;
  } catch {
    user = null;
  }

  // Only cache a successful lookup — do not cache nulls, so a transient WorkOS
  // outage or misconfiguration doesn't pin every request to "not found" for
  // the full TTL.
  if (user) workosUserCache.set(sub, { user, expiresAt: Date.now() + WORKOS_USER_CACHE_TTL_MS });
  return user;
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Verify a WorkOS Bearer JWT and resolve the Velora businessId from it.
 *
 * Called from the MCP route handler AFTER the HMAC check fails (i.e., no
 * x-api-key header). Returns a typed discriminated union.
 */
export async function verifyBearerToken(
  authHeader: string | null,
): Promise<BearerVerifyResult> {
  // ── Guard: OAuth not configured ────────────────────────────────────────────
  const jwksUrl = process.env.WORKOS_JWKS_URL;
  const issuer = process.env.WORKOS_AS_ISSUER;

  if (!jwksUrl || !issuer) {
    return {
      ok: false,
      status: 401,
      code: "OAUTH_NOT_CONFIGURED",
      message: "OAuth Bearer auth is not configured on this server.",
    };
  }

  // ── Extract raw token ──────────────────────────────────────────────────────
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return {
      ok: false,
      status: 401,
      code: "UNAUTHORIZED",
      message: "Missing or malformed Authorization header.",
    };
  }
  const token = authHeader.slice("Bearer ".length).trim();

  // ── Verify signature + claims ──────────────────────────────────────────────
  const jwks = getJwks();
  if (!jwks) {
    // Should not happen given the env guard above, but defend anyway.
    return {
      ok: false,
      status: 401,
      code: "OAUTH_NOT_CONFIGURED",
      message: "JWKS not available.",
    };
  }

  let result: JWTVerifyResult;
  try {
    result = await jwtVerify(token, jwks, {
      issuer,
      // RFC 8707 audience binding: reject tokens not issued for Velora's MCP URI.
      // This is the critical anti-token-reuse check from the MCP spec.
      audience: MCP_RESOURCE_URI,
      // Require exp + sub — jose only validates these when present; listing them
      // here makes absence a hard rejection. A token without an expiry or without
      // a subject claim must be rejected before it reaches provisioning.
      requiredClaims: ["exp", "sub"],
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "token verification failed";
    reportWarning("MCP OAuth: token verification failed", {
      scope: "mcp.oauth-verify",
      error: msg,
    });
    return {
      ok: false,
      status: 401,
      code: "INVALID_TOKEN",
      message: "Token verification failed.",
    };
  }

  // ── Extract identity ───────────────────────────────────────────────────────
  // WorkOS access tokens do NOT embed profile claims, so email is usually absent
  // from the JWT. When present (custom claims / other IdPs) we use it directly;
  // otherwise we resolve email + email_verified from the WorkOS Management API
  // by user id (the `sub` claim).
  let email = result.payload["email"];
  let emailVerified = result.payload["email_verified"];
  if (typeof email !== "string" || !email) {
    const user = await fetchWorkosUser(result.payload.sub);
    email = user?.email;
    emailVerified = user?.email_verified;
  }

  if (typeof email !== "string" || !email) {
    reportWarning("MCP OAuth: token missing email claim", {
      scope: "mcp.oauth-verify",
      sub: result.payload.sub,
    });
    return {
      ok: false,
      status: 401,
      code: "INVALID_TOKEN",
      message: "Token does not contain a valid email claim.",
    };
  }

  // Guard: email must be verified — mirrors auth-signin-callback.ts (L63) and the
  // owner native session MCP route auth (L57). Defense-in-depth against non-Google
  // WorkOS identity methods that may issue unverified email claims.
  if (emailVerified !== true) {
    reportWarning("MCP OAuth: token email is not verified", {
      scope: "mcp.oauth-verify",
      sub: result.payload.sub,
    });
    return {
      ok: false,
      status: 401,
      code: "UNVERIFIED_EMAIL",
      message: "Token email address is not verified.",
    };
  }

  // ── Resolve Velora tenant ──────────────────────────────────────────────────
  // User.email is @unique in the Prisma schema. Business is 1-to-1 with User.
  // We select only what we need (businessId) — no unnecessary data returned.
  const user = await prisma.user.findUnique({
    where: { email },
    select: {
      business: { select: { id: true } },
    },
  });

  if (!user?.business?.id) {
    // No existing tenant — JIT-provision User + Business for this verified WorkOS user.
    // Standard first-OIDC-login pattern: anchor on `sub` (via Account row), not email alone.
    // Only verified emails reach this point (guard above); unverified are rejected at L197.
    try {
      const businessId = await provisionTenantForWorkosUser({
        sub: result.payload.sub as string,
        email,
        emailVerified: true,
      });
      return { ok: true, businessId };
    } catch (err) {
      // Distinguish the cross-provider refusal (client error) from a genuine
      // server failure (DB down, unexpected throw). Surfacing a 500 for the latter
      // lets clients distinguish "you need to link" vs "we failed" and avoids
      // leaking internal details under the same generic NO_VELORA_TENANT code.
      if (err instanceof EmailAlreadyRegisteredError) {
        cloudLog({
          severity: "WARNING",
          component: "System",
          action: "MCP_JIT_CROSS_PROVIDER_REFUSED",
          a2a_transfer: false,
          message: "JIT provisioning refused: email already registered via a different sign-in method",
          businessId: "",
          data: { email, sub: result.payload.sub },
        });
        return {
          ok: false,
          status: 403,
          code: "ACCOUNT_NEEDS_LINKING",
          message:
            "This email is already registered via a different sign-in method. " +
            "Please sign in with your original method and link your WorkOS account explicitly.",
        };
      }

      cloudLog({
        severity: "ERROR",
        component: "System",
        action: "MCP_JIT_PROVISION_FAILED",
        a2a_transfer: false,
        message: "JIT tenant provisioning failed for WorkOS user",
        businessId: "",
        data: {
          email,
          sub: result.payload.sub,
          error: err instanceof Error ? err.message : String(err),
        },
      });
      return {
        ok: false,
        status: 500,
        code: "PROVISIONING_ERROR",
        message: "Tenant provisioning failed due to a server error. Please try again.",
      };
    }
  }

  return { ok: true, businessId: user.business.id };
}

/**
 * The canonical MCP resource URI — exported so the .well-known route and
 * the MCP route handler can share a single source of truth.
 */
export { MCP_RESOURCE_URI };
