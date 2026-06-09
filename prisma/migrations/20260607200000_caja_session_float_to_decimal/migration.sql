-- Migration: CajaSession Float → NUMERIC(14,2) for exact money arithmetic
--
-- Problem: DOUBLE PRECISION accumulates IEEE-754 rounding error in cash
-- reconciliation (e.g. variance = -0.0000002 instead of 0).
-- Fix: NUMERIC(14,2) — exact fixed-point arithmetic, zero drift.
--
-- Source: https://www.postgresql.org/docs/current/datatype-numeric.html
--   "If you require exact storage and calculations (such as for monetary
--    amounts), use the numeric type instead."
--
-- Cast is safe: existing DOUBLE PRECISION values have at most 2 significant
-- decimal places (they were entered as ARS amounts). The USING clause forces
-- Postgres to truncate/round at 2dp at migration time — no data loss.
--
-- Idempotency note: ALTER COLUMN TYPE on a NUMERIC(14,2) column that is
-- already NUMERIC(14,2) is a no-op in Postgres (same type → no table rewrite).

ALTER TABLE "CajaSession"
  ALTER COLUMN "openedCashAmount"   TYPE NUMERIC(14,2)
    USING "openedCashAmount"::numeric(14,2);

ALTER TABLE "CajaSession"
  ALTER COLUMN "closedCashAmount"   TYPE NUMERIC(14,2)
    USING "closedCashAmount"::numeric(14,2);

ALTER TABLE "CajaSession"
  ALTER COLUMN "expectedCashAmount" TYPE NUMERIC(14,2)
    USING "expectedCashAmount"::numeric(14,2);

ALTER TABLE "CajaSession"
  ALTER COLUMN "variance"           TYPE NUMERIC(14,2)
    USING "variance"::numeric(14,2);
