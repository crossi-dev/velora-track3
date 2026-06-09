import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { cloudLog } from "@/lib/cloud-logger";
import { verifyCronAuth } from "./cron-auth";

/**
 * Verifies a cron-route request. Now delegates to `verifyCronAuth` which
 * tries OIDC (preferred — Google-signed JWT validated against JWKs with
 * audience + issuer checks) and falls back to the legacy bearer secret
 * during scheduler migration. Async because OIDC verification requires
 * key resolution.
 *
 * Returns `null` on success; otherwise a 401 NextResponse.
 *
 *   const unauth = await verifyCronSecret(req, "scope-name");
 *   if (unauth) return unauth;
 */
export async function verifyCronSecret(req: NextRequest, scope: string = "cron"): Promise<NextResponse | null> {
  return verifyCronAuth(req, scope);
}

type ParsedJson<T> =
  | { ok: true; data: T }
  | { ok: false; response: NextResponse };

export function jsonError(code: string, message: string, status: number) {
  return NextResponse.json({ code, message }, { status });
}

export function unauthorized() {
  return jsonError("UNAUTHORIZED", "Authentication required.", 401);
}

export function badRequest(message: string) {
  return jsonError("BAD_REQUEST", message, 400);
}

export function notFound(message: string) {
  return jsonError("NOT_FOUND", message, 404);
}

export function conflict(message: string) {
  return jsonError("CONFLICT", message, 409);
}

export function internalError(message: string) {
  return jsonError("INTERNAL_ERROR", message, 500);
}

export async function parseJsonBody<T>(req: NextRequest): Promise<ParsedJson<T>> {
  try {
    return { ok: true, data: (await req.json()) as T };
  } catch {
    return { ok: false, response: jsonError("INVALID_JSON", "Invalid JSON body.", 400) };
  }
}

const businessIdCacheTtlMs = 60_000;
const businessIdCache = new Map<string, { value: string; expiresAt: number }>();

export async function getBusinessIdForUser(userId: string | undefined | null) {
  if (!userId) return null;
  const cached = businessIdCache.get(userId);
  if (cached && Date.now() < cached.expiresAt) return cached.value;
  const biz = await prisma.business.findUnique({
    where: { userId },
    select: { id: true },
  });
  const id = biz?.id ?? null;
  if (id) businessIdCache.set(userId, { value: id, expiresAt: Date.now() + businessIdCacheTtlMs });
  return id;
}

function summarizeRouteError(error: unknown) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      // Always include stack so Cloud Error Reporting can group by call site.
      stack: error.stack ?? null,
    };
  }

  if (typeof error === "string") {
    return {
      name: "Error",
      message: error,
    };
  }

  try {
    return {
      name: "NonError",
      message: JSON.stringify(error),
    };
  } catch {
    return {
      name: "NonError",
      message: String(error),
    };
  }
}

export function logRouteError(scope: string, error: unknown, context?: Record<string, unknown>) {
  const summary = summarizeRouteError(error);
  cloudLog({
    severity: "ERROR",
    component: "System",
    action: scope,
    a2a_transfer: false,
    message: summary.message,
    // stack_trace at root level — Cloud Error Reporting requires this field at the
    // jsonPayload root to auto-group errors by call site. Nested in `data` is invisible.
    stack_trace: "stack" in summary ? (summary.stack ?? undefined) : undefined,
    data: { errorName: summary.name, ...context },
  });
}

// ---------------------------------------------------------------------------
// Rate limit helpers — public API. Internal machinery lives in rate-limit-core.ts.
//
// Dual-mode: in-memory sliding window (default, single-instance) OR
// Postgres token bucket (RATE_LIMIT_USE_DB=true, multi-instance safe).
// Kill-switch: RATE_LIMIT_ENABLED=false (dev/test).
// Scopes: "expensive"=5/min, "upload"=10/min, "public"=30/min, default=120/min.
// ---------------------------------------------------------------------------

import { checkRateLimitCore, checkRateLimitCoreAsync, DEFAULT_MAX_REQUESTS, bypassIfTester } from "./rate-limit-core";
export { bypassIfTester };

const DEFAULT_WINDOW_SECONDS = 60;

/**
 * Rate limit check. Defaults to 120 req/min per IP.
 * Pass a scope to isolate a bucket (e.g. "auth-signin").
 * Pass bypass: true (via bypassIfTester) to skip all checks for tester actors.
 * Pass actorKey to override IP-based keying (use for A2A routes where all
 * internal Cloud Run self-calls share the same egress IP).
 * Set RATE_LIMIT_USE_DB=true for multi-instance Postgres-backed enforcement.
 */
export function checkRateLimit(
  req: NextRequest,
  scope?: string,
  maxRequests: number = DEFAULT_MAX_REQUESTS,
  windowSeconds: number = DEFAULT_WINDOW_SECONDS,
  options?: { bypass?: boolean; actorKey?: string }
): NextResponse | null {
  return checkRateLimitCore(req, scope, maxRequests, windowSeconds, options);
}

/**
 * Async rate limit check — awaits the DB token bucket result.
 *
 * Use for high-cost routes (LLM-backed) where awaiting the DB check (~5–15 ms)
 * is negligible vs LLM latency and prevents the fire-and-forget leakage.
 * PERF-3 fix (Google 2026 holistic audit).
 */
export async function checkRateLimitAsync(
  req: NextRequest,
  scope?: string,
  maxRequests: number = DEFAULT_MAX_REQUESTS,
  windowSeconds: number = DEFAULT_WINDOW_SECONDS,
  options?: { bypass?: boolean; actorKey?: string }
): Promise<NextResponse | null> {
  return checkRateLimitCoreAsync(req, scope, maxRequests, windowSeconds, options);
}

// ---------------------------------------------------------------------------
// Scope-specific rate limit helpers (production-calibrated for 100 businesses)
// ---------------------------------------------------------------------------

/**
 * For expensive / heavy endpoints: audit export, analytics, bulk imports.
 * 5 req/min per IP — these hit Postgres with large scans or write 500 rows.
 */
export function checkRateLimitExpensive(req: NextRequest, options?: { bypass?: boolean }): NextResponse | null {
  return checkRateLimit(req, "expensive", 5, 60, options);
}

/**
 * For file upload / parse endpoints (photo-extract, upload-file).
 * 10 req/min per IP — file parsing is CPU/memory-bound.
 */
export function checkRateLimitUpload(req: NextRequest, options?: { bypass?: boolean }): NextResponse | null {
  return checkRateLimit(req, "upload", 10, 60, options);
}

/**
 * For public / unauthenticated endpoints (landing, auth initiation).
 * 30 req/min per IP — tighter than authenticated, no actor to key on.
 */
export function checkRateLimitPublic(req: NextRequest, options?: { bypass?: boolean }): NextResponse | null {
  return checkRateLimit(req, "public", 30, 60, options);
}
