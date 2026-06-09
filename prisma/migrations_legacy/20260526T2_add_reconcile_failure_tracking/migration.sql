-- Inline-DLQ columns for PaymentIntent reconcile failure tracking.
-- Industry standard: Stripe retry-budget pattern (max 72h / ~72 attempts at
-- 1-min cron). Postgres inline-DLQ (counter + last-error on the row itself)
-- is preferred over a separate DLQ table at this scale because the failure
-- universe is bounded to fast-tracked PIs only (typically < 10 at once),
-- visibility is immediate on the same row, and no additional join is needed.
-- Ref: https://docs.stripe.com/webhooks/process-undelivered-events
--      https://www.diljitpr.net/blog-post-postgresql-dlq (inline vs separate trade-off)
--
-- reconcileFailureCount: NOT NULL DEFAULT 0 — safe arithmetic, no NULL checks.
-- reconcileLastError:    NULL default — only populated after first failure.
-- Both columns are additive — no existing rows are affected.

ALTER TABLE "PaymentIntent"
  ADD COLUMN IF NOT EXISTS "reconcileFailureCount" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "PaymentIntent"
  ADD COLUMN IF NOT EXISTS "reconcileLastError" VARCHAR(500);
