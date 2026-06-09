-- Migration: add_rate_limit_bucket
-- Adds RateLimitBucket table for distributed, multi-instance-safe token bucket rate limiting.
--
-- Algorithm: token bucket with lazy refill.
--   - Each key (scope:ip) gets a bucket with `capacity` tokens.
--   - On each request: tokens += elapsed_seconds * refill_rate, capped to capacity, then -1.
--   - If tokens < 0 after decrement → 429. The atomic CTE prevents double-spend.
--
-- Cleanup: audit-cleanup cron deletes rows with updatedAt > 7 days (inactive buckets).
-- The index on updated_at makes that DELETE O(pruned).

CREATE TABLE "RateLimitBucket" (
    "key"          TEXT         NOT NULL,
    "tokens"       DOUBLE PRECISION NOT NULL,
    "capacity"     DOUBLE PRECISION NOT NULL,
    "refillRate"   DOUBLE PRECISION NOT NULL,
    "lastRefillAt" TIMESTAMP(3) NOT NULL,
    "updatedAt"    TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RateLimitBucket_pkey" PRIMARY KEY ("key")
);

CREATE INDEX "RateLimitBucket_updatedAt_idx" ON "RateLimitBucket"("updatedAt");
