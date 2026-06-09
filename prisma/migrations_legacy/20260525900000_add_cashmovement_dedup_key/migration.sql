-- Migration: add clientMessageId dedup column to CashMovement
-- Fixes CRIT-2: standalone cash movements (saleId=null) only relied on IdempotencyRecord
-- for dedup. A retry from a different client or a cold-start race could bypass it.
-- Fix: require X-Idempotency-Key at route level (already enforced via use-case) and
-- persist it as clientMessageId. Partial unique index fires only when non-null.

ALTER TABLE "CashMovement"
  ADD COLUMN "clientMessageId" TEXT;

-- Partial unique index: enforces dedup for explicit client keys; leaves legacy null rows untouched.
CREATE UNIQUE INDEX "CashMovement_businessId_clientMessageId_key"
  ON "CashMovement" ("businessId", "clientMessageId")
  WHERE "clientMessageId" IS NOT NULL;
