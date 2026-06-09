/**
 * rate-limit-core.ts — Internal rate limiting machinery.
 *
 * Dual-mode: in-memory sliding window (single-instance, default) OR
 * Postgres token bucket (RATE_LIMIT_USE_DB=true, multi-instance safe).
 *
 * DB mode: local check first (burst protection), then async DB decrement.
 * If DB denies, the key lands in denySet → next request is blocked locally.
 * At-most-1-request grace per cold start; acceptable for fairness-layer limiting.
 *
 * Fail-open: DB errors are logged as WARNING and the request is allowed.
 * Rate limiting is a fairness layer — blocking traffic due to DB lag is worse.
 *
 * Kill-switch: RATE_LIMIT_ENABLED=false skips all checks (dev/test).
 *
 * See rate-limit-token-bucket.ts for the Postgres token bucket implementation.
 */

import { NextRequest, NextResponse } from "next/server";
import { cloudLog } from "@/lib/cloud-logger";
import { getClientIp } from "@/lib/client-ip";

const DEFAULT_WINDOW_MS = 60_000;
export const DEFAULT_MAX_REQUESTS = 120;
const RATE_LIMIT_MAX_KEYS = 10_000;

// ── In-memory sliding window ───────────────────────────────────────────────

const rateLimitMap = new Map<string, number[]>();

function pruneStaleEntries(cutoff: number) {
  for (const [key, timestamps] of rateLimitMap) {
    if (timestamps.length === 0 || timestamps[timestamps.length - 1] <= cutoff) {
      rateLimitMap.delete(key);
    }
  }
}

function enforceHardCap() {
  if (rateLimitMap.size <= RATE_LIMIT_MAX_KEYS) return;
  // O(excessCount) eviction — Maps preserve insertion order (ES2015+), so
  // iterating from the front drops the oldest-inserted keys first without
  // the O(N log N) Array.sort that tanda 3 fixed in ai-rate-limit.ts.
  // Tanda 3 commit 597abcf7 fixed the same bug in the AI limiter; this
  // ports the same pattern to the general-purpose limiter.
  const excessCount = rateLimitMap.size - RATE_LIMIT_MAX_KEYS;
  let evicted = 0;
  for (const key of rateLimitMap.keys()) {
    if (evicted >= excessCount) break;
    rateLimitMap.delete(key);
    evicted++;
  }
}

function checkInMemory(
  key: string,
  maxRequests: number,
  windowMs: number,
  windowSeconds: number
): NextResponse | null {
  const now = Date.now();
  const cutoff = now - windowMs;
  pruneStaleEntries(cutoff);
  const timestamps = rateLimitMap.get(key) ?? [];
  const recent = timestamps.filter((t) => t > cutoff);
  recent.push(now);
  rateLimitMap.set(key, recent);
  enforceHardCap();
  if (recent.length > maxRequests) {
    return NextResponse.json(
      { code: "RATE_LIMITED", message: "Too many requests. Try again in a minute." },
      { status: 429, headers: { "Retry-After": String(windowSeconds) } }
    );
  }
  return null;
}

// ── DB deny-set (async enforcement) ───────────────────────────────────────

const denySet = new Map<string, number>(); // key → expiresAt ms

function isDenied(key: string): boolean {
  const exp = denySet.get(key);
  if (!exp) return false;
  if (Date.now() > exp) { denySet.delete(key); return false; }
  return true;
}

function markDenied(key: string, windowMs: number) {
  denySet.set(key, Date.now() + windowMs);
}

async function fireDbCheck(
  key: string,
  maxRequests: number,
  windowSeconds: number,
  windowMs: number
): Promise<void> {
  try {
    const { consumeToken } = await import("./rate-limit-token-bucket");
    const result = await consumeToken(key, {
      capacity: maxRequests,
      refillRate: maxRequests / windowSeconds,
    });
    if (!result.allowed) markDenied(key, windowMs);
  } catch {
    // consumeToken already logs; fail-open.
  }
}

// ── Tester bypass ──────────────────────────────────────────────────────────

/**
 * Returns { bypass: true } when the actor is in the tester allowlist.
 *
 * The tester allowlist (src/lib/tester-allowlist.ts) is hardcoded in source —
 * adding an entry requires a PR, so the bypass surface is auditable via git
 * blame. Bypass is active in production for those audited emails so the
 * owner can dogfood Velora at full speed without self-rate-limiting on the
 * dashboard polling loop. SEC-N-9's concern about "compromised allowlist
 * email = unlimited Vertex calls" is addressed by the audit trail + the
 * RATE_LIMIT_BYPASS_TESTER log emitted by checkRateLimitCore on every bypass.
 */
export function bypassIfTester(actor: { isTester?: boolean } | null | undefined): { bypass: boolean } {
  return { bypass: !!actor?.isTester };
}

// ── Public check function ──────────────────────────────────────────────────

export function checkRateLimitCore(
  req: NextRequest,
  scope: string | undefined,
  maxRequests: number,
  windowSeconds: number,
  options?: { bypass?: boolean; actorKey?: string }
): NextResponse | null {
  if (options?.bypass === true) {
    cloudLog({
      severity: "INFO",
      component: "System",
      action: "RATE_LIMIT_BYPASS_TESTER",
      a2a_transfer: false,
      message: "Rate limit bypassed for tester actor",
      data: { scope: scope ?? "default" },
    });
    return null;
  }

  if (process.env.RATE_LIMIT_ENABLED === "false") return null;

  // actorKey overrides IP-based keying. Used for A2A routes where internal
  // Cloud Run self-calls share the same egress IP ("unknown"), making IP
  // buckets useless — all businesses would drain a single shared counter.
  let actor: string;
  if (options?.actorKey) {
    actor = options.actorKey;
  } else {
    actor = getClientIp(req.headers);
  }

  const windowMs = windowSeconds * 1000;
  const key = scope ? `${scope}:${actor}` : actor;

  // DB mode: on by default in production; override with RATE_LIMIT_USE_DB=false.
  // In-memory (single-instance) is the fallback for dev/test where multi-instance
  // enforcement is irrelevant. With N Cloud Run instances, in-memory effective quota
  // is N × maxRequests — the Postgres token bucket collapses this to the real limit.
  const useDb =
    process.env.RATE_LIMIT_USE_DB === "true" ||
    (process.env.NODE_ENV === "production" && process.env.RATE_LIMIT_USE_DB !== "false");

  // DB mode: deny-set check (populated asynchronously after prior requests).
  if (useDb && isDenied(key)) {
    return NextResponse.json(
      { code: "RATE_LIMITED", message: "Too many requests. Try again in a minute." },
      { status: 429, headers: { "Retry-After": String(windowSeconds) } }
    );
  }

  // Local sliding-window — always runs; provides per-instance burst protection.
  const local = checkInMemory(key, maxRequests, windowMs, windowSeconds);
  if (local) return local;

  // DB token bucket — fire-and-forget; populates deny-set for next request.
  if (useDb) {
    void fireDbCheck(key, maxRequests, windowSeconds, windowMs);
  }

  return null;
}

/**
 * Async variant of checkRateLimitCore — awaits the DB token bucket result.
 *
 * Use for high-cost routes (e.g. /api/business-assistant) where the DB
 * round-trip (~5–15 ms for Supabase pgbouncer) is acceptable relative to the
 * LLM latency (6–25 s). Awaiting prevents the "one extra request per instance"
 * leakage that the fire-and-forget variant allows under sustained burst.
 *
 * PERF-3 fix from Google 2026 holistic audit.
 */
export async function checkRateLimitCoreAsync(
  req: NextRequest,
  scope: string | undefined,
  maxRequests: number,
  windowSeconds: number,
  options?: { bypass?: boolean; actorKey?: string }
): Promise<NextResponse | null> {
  if (options?.bypass === true) {
    cloudLog({
      severity: "INFO",
      component: "System",
      action: "RATE_LIMIT_BYPASS_TESTER",
      a2a_transfer: false,
      message: "Rate limit bypassed for tester actor",
      data: { scope: scope ?? "default" },
    });
    return null;
  }

  if (process.env.RATE_LIMIT_ENABLED === "false") return null;

  let actor: string;
  if (options?.actorKey) {
    actor = options.actorKey;
  } else {
    actor = getClientIp(req.headers);
  }

  const windowMs = windowSeconds * 1000;
  const key = scope ? `${scope}:${actor}` : actor;

  const useDb =
    process.env.RATE_LIMIT_USE_DB === "true" ||
    (process.env.NODE_ENV === "production" && process.env.RATE_LIMIT_USE_DB !== "false");

  // Deny-set check — populated by prior async DB bucket results.
  if (useDb && isDenied(key)) {
    return NextResponse.json(
      { code: "RATE_LIMITED", message: "Too many requests. Try again in a minute." },
      { status: 429, headers: { "Retry-After": String(windowSeconds) } }
    );
  }

  // In-memory sliding window — fast path, burst protection.
  const local = checkInMemory(key, maxRequests, windowMs, windowSeconds);
  if (local) return local;

  // DB token bucket — awaited so the bucket state is authoritative before
  // this request proceeds. The extra ~5–15 ms round-trip is negligible compared
  // to LLM latency (6–25 s) on the AI route.
  if (useDb) {
    try {
      const { consumeToken } = await import("./rate-limit-token-bucket");
      const result = await consumeToken(key, {
        capacity: maxRequests,
        refillRate: maxRequests / windowSeconds,
      });
      if (!result.allowed) {
        markDenied(key, windowMs);
        return NextResponse.json(
          { code: "RATE_LIMITED", message: "Too many requests. Try again in a minute." },
          { status: 429, headers: { "Retry-After": String(windowSeconds) } }
        );
      }
    } catch {
      // consumeToken already logs; fail-open.
    }
  }

  return null;
}

/**
 * Returns true when the auth rate limiter should be active.
 * In production (NODE_ENV=production) it is ALWAYS active.
 * In non-production it respects RATE_LIMIT_AUTH_ENABLED env flag
 * (defaults to active unless explicitly set to "false").
 * RATE_LIMIT_ENABLED does NOT disable the auth limiter — use
 * RATE_LIMIT_AUTH_ENABLED=false for that in non-production environments.
 *
 * NOTE: do NOT import this in middleware.ts — that file runs on Edge Runtime
 * and this module loads Prisma (non-Edge-compatible). Inline the env checks
 * directly in middleware instead.
 */
export function isAuthRateLimitEnabled(): boolean {
  if (process.env.NODE_ENV === "production") return true;
  return process.env.RATE_LIMIT_AUTH_ENABLED !== "false";
}

export { DEFAULT_WINDOW_MS };
