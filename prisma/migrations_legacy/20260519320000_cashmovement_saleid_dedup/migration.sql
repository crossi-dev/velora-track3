-- Migration: 20260519320000_cashmovement_saleid_dedup
-- Fix B-1: The previous partial index only prevented two 'income' movements for
-- the same saleId. The real race is between type='sale' (written by sale-transaction.ts)
-- and type='income' (written by confirm-transaction.ts). Drop the narrow index and
-- replace with one that covers both types so the DB enforces at-most-one cash
-- movement of type 'income' OR 'sale' per saleId.
-- 'refund' movements are intentionally excluded so refunds remain permitted.

DROP INDEX IF EXISTS "CashMovement_saleId_income_key";

CREATE UNIQUE INDEX "CashMovement_saleId_cash_key"
    ON "CashMovement"("saleId")
    WHERE "saleId" IS NOT NULL AND "type" IN ('income', 'sale');
