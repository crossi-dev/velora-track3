/**
 * rate-limit-token-bucket.ts — Distributed token bucket backed by Postgres.
 *
 * WHY TOKEN BUCKET vs SLIDING WINDOW LOG
 * ───────────────────────────────────────
 * The in-memory implementation uses a sliding window log (Map<key, timestamp[]>).
 * It works well single-instance but each Cloud Run instance has its own Map — two
 * instances means 2× effective quota. Token bucket in Postgres solves this:
 * every instance hits the same row, the atomic CTE guarantees no race conditions.
 *
 * WHY POSTGRES, NOT REDIS
 * ───────────────────────
 * Velora already has Postgres on Neon. Adding Redis (Upstash, Memorystore) would
 * introduce a new infrastructure dependency, billing surface, and failure mode.
 * Postgres is perfectly capable of ~100 QPS rate-limit checks with primary-key
 * upserts. Latency is ~10–30 ms per check (Neon sa-east-1, same region as Cloud Run).
 *
 * ALGORITHM
 * ─────────
 * Lazy refill token bucket:
 *   1. On each request, compute elapsed = now - lastRefillAt (seconds).
 *   2. Refill: new_tokens = MIN(capacity, current_tokens + elapsed * refillRate).
 *   3. Attempt to consume 1 token: UPDATE ... SET tokens = new_tokens - 1 WHERE tokens >= 1.
 *   4. If 0 rows updated → bucket empty → 429. Otherwise → allowed.
 *
 * The INSERT + UPDATE are wrapped in a single CTE so Postgres executes them atomically.
 * Multiple instances hitting the same row get serialized by Postgres row-level locking.
 *
 * FAIL-OPEN POLICY
 * ─────────────────
 * If the DB is unreachable (Neon timeout, connection exhaustion), we log a WARNING
 * and ALLOW the request. Rate limiting is a fairness/burst-protection layer — not a
 * security gate. Blocking ALL traffic because DB is slow would be worse than a brief
 * quota bypass. Real abuse mitigation lives in Cloud Armor and auth locks.
 *
 * LATENCY
 * ───────
 * Expect 10–30 ms per check (Neon sa-east-1 roundtrip). Velora makes at most ONE
 * rate-limit check per request path — scopes are exclusive. Total overhead ≤ 30 ms.
 * Monitor Neon compute-unit consumption at scale: 100 businesses × 50 req/min ≈ 83 QPS.
 */

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { cloudLog } from "@/lib/cloud-logger";

export interface TokenBucketConfig {
  /** Maximum tokens the bucket can hold (= maxRequests per window). */
  capacity: number;
  /** Tokens added per second = capacity / windowSeconds. */
  refillRate: number;
}

export interface ConsumeResult {
  allowed: boolean;
  /** Tokens remaining after this request (0 if denied). */
  remaining: number;
}

/**
 * Consume one token from the bucket identified by `key`.
 *
 * The first call for a new key INSERTs the row with full capacity minus 1.
 * Subsequent calls do a lazy refill then decrement atomically.
 *
 * Returns `{ allowed: true }` on success, `{ allowed: false }` when the bucket
 * is empty. On DB failure, fails open (allowed: true) and logs a warning.
 */
export async function consumeToken(
  key: string,
  config: TokenBucketConfig
): Promise<ConsumeResult> {
  const { capacity, refillRate } = config;

  try {
    /**
     * Atomic CTE:
     * Step 1 — INSERT with full capacity (minus 1 for this request).
     *   ON CONFLICT: refresh the tokens using lazy refill formula.
     *   Result: the row now holds the refilled token count (not yet decremented).
     *
     * Step 2 — UPDATE to decrement 1 token, but ONLY if tokens >= 1.
     *   RETURNING tokens gives us the post-decrement balance.
     *   If 0 rows returned → bucket was empty → deny.
     *
     * Both steps run inside the same implicit transaction on Postgres, which means
     * the UPDATE sees the INSERT/upsert result before any other concurrent writer.
     */
    const rows = await prisma.$queryRaw<Array<{ tokens: number }>>(Prisma.sql`
      WITH refilled AS (
        INSERT INTO "RateLimitBucket" (
          "key", "tokens", "capacity", "refillRate", "lastRefillAt", "updatedAt"
        )
        VALUES (
          ${key},
          ${capacity},
          ${capacity},
          ${refillRate},
          NOW(),
          NOW()
        )
        ON CONFLICT ("key") DO UPDATE SET
          -- Update capacity/refillRate from the current config: if the code
          -- bumped a route's max from 20 to 60, existing buckets immediately
          -- adopt the new limit instead of being permanently pinned at their
          -- creation-time value. Without this, a one-time row created when
          -- max=20 would silently keep enforcing 20 tokens forever, even
          -- after the code change shipped (root cause of the path-juan
          -- session 2026-05-26 rate-limit "ghost" — bucket capacity ignored
          -- the new max=60 in the route).
          "capacity"   = ${capacity},
          "refillRate" = ${refillRate},
          "tokens" = LEAST(
            ${capacity}::float,
            "RateLimitBucket"."tokens"
              + EXTRACT(EPOCH FROM (NOW() - "RateLimitBucket"."lastRefillAt"))
              * ${refillRate}::float
          ),
          "lastRefillAt" = NOW(),
          "updatedAt"    = NOW()
        RETURNING "tokens", "capacity"
      )
      UPDATE "RateLimitBucket"
      SET    "tokens" = refilled.tokens - 1
      FROM   refilled
      WHERE  "RateLimitBucket"."key" = ${key}
        AND  refilled.tokens >= 1
      RETURNING "RateLimitBucket"."tokens"
    `);

    if (rows.length === 0) {
      // No row updated → bucket was at 0 after refill → deny.
      return { allowed: false, remaining: 0 };
    }

    const remaining = Math.max(0, Number(rows[0].tokens));
    return { allowed: true, remaining };
  } catch (err) {
    // Fail-open: DB unreachable. Log warning; don't block legitimate traffic.
    cloudLog({
      severity: "WARNING",
      component: "System",
      action: "RATE_LIMIT_DB_FAIL_OPEN",
      a2a_transfer: false,
      message: "Token bucket DB check failed — failing open",
      data: {
        key,
        error: err instanceof Error ? err.message : String(err),
      },
    });
    return { allowed: true, remaining: -1 };
  }
}

/**
 * Delete RateLimitBucket rows not updated in the last `staleAfterDays` days.
 * Called by the audit-cleanup cron to prevent unbounded table growth.
 */
export async function cleanStaleBuckets(staleAfterDays: number): Promise<number> {
  const cutoff = new Date(Date.now() - staleAfterDays * 24 * 60 * 60 * 1000);
  const r = await prisma.rateLimitBucket.deleteMany({
    where: { updatedAt: { lt: cutoff } },
  });
  return r.count;
}
