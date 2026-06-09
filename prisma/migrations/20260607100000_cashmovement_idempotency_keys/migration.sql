-- Migration: 20260607100000_cashmovement_idempotency_keys
-- ERP-hardening SLICE 1: ensure every core cash money-write carries a stable
-- clientMessageId idempotency key and the DB-level partial unique index that
-- deduplicates concurrent retries via P2002.
--
-- What changed in code (no DB schema change needed — column and index already
-- existed via migrations_legacy):
--   - register-promesa-sale.transaction.ts: added clientMessageId = "promesa-sale-{idempotencyKey}"
--   - refund-transaction.ts: added clientMessageId = "refund-{paymentIntentId}"
--
-- This migration ensures the required column and index exist on any fresh DB
-- that applies migrations in order (0_init does not include them).
--
-- Idempotency-key pattern: Stripe idempotency-key standard — every money-write
-- carries a stable deterministic key so retries cannot double-book cash. The DB
-- partial unique index (WHERE clientMessageId IS NOT NULL) is the backstop.
--
-- Sources:
--   https://docs.stripe.com/api/idempotent_requests
--   https://www.postgresql.org/docs/current/indexes-partial.html

-- Add clientMessageId column if not already present (idempotent via IF NOT EXISTS).
ALTER TABLE "CashMovement"
  ADD COLUMN IF NOT EXISTS "clientMessageId" TEXT;

-- Partial unique index: fires only when clientMessageId IS NOT NULL.
-- Leaves legacy null rows untouched; enforces dedup for new idempotent writes.
CREATE UNIQUE INDEX IF NOT EXISTS "CashMovement_businessId_clientMessageId_key"
  ON "CashMovement" ("businessId", "clientMessageId")
  WHERE "clientMessageId" IS NOT NULL;
