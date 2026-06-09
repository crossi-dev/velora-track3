-- Migration: 20260519280000_critical_integrity_fixes
-- Critical DB integrity hardening: cascade deletes, missing indexes,
-- unique constraints, CHECK constraints, and A2A JTI replay cache table.

-- ── A2A JTI nonce cache ────────────────────────────────────────────────────────
-- New table for replay protection. @id on jti = unique by design.
CREATE TABLE "A2aJtiSeen" (
    "jti"       TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "A2aJtiSeen_pkey" PRIMARY KEY ("jti")
);

CREATE INDEX "A2aJtiSeen_expiresAt_idx" ON "A2aJtiSeen"("expiresAt");

-- ── Cascade deletes on Business relations ─────────────────────────────────────
-- 7 models that were missing onDelete: Cascade. Safe: existing data has valid
-- businessId FKs. Adding CASCADE only affects future DELETE on Business rows.

ALTER TABLE "Product" DROP CONSTRAINT "Product_businessId_fkey";
ALTER TABLE "Product" ADD CONSTRAINT "Product_businessId_fkey"
    FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Customer" DROP CONSTRAINT "Customer_businessId_fkey";
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_businessId_fkey"
    FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Supplier" DROP CONSTRAINT "Supplier_businessId_fkey";
ALTER TABLE "Supplier" ADD CONSTRAINT "Supplier_businessId_fkey"
    FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Sale" DROP CONSTRAINT "Sale_businessId_fkey";
ALTER TABLE "Sale" ADD CONSTRAINT "Sale_businessId_fkey"
    FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CashMovement" DROP CONSTRAINT "CashMovement_businessId_fkey";
ALTER TABLE "CashMovement" ADD CONSTRAINT "CashMovement_businessId_fkey"
    FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "StockMovement" DROP CONSTRAINT "StockMovement_businessId_fkey";
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_businessId_fkey"
    FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Budget" DROP CONSTRAINT "Budget_businessId_fkey";
ALTER TABLE "Budget" ADD CONSTRAINT "Budget_businessId_fkey"
    FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Missing indexes ────────────────────────────────────────────────────────────

-- CriticalWriteEvent: resourceId queries (audit log lookup by resource)
CREATE INDEX "CriticalWriteEvent_businessId_resourceId_idx"
    ON "CriticalWriteEvent"("businessId", "resourceId");

-- MlCredential: mlUserId lookup (webhook correlation)
CREATE INDEX "MlCredential_mlUserId_idx" ON "MlCredential"("mlUserId");

-- ── Unique constraint on Supplier(businessId, name) ───────────────────────────
-- Prevents duplicate supplier names within a business. Safe: check for
-- existing duplicates before applying; migration will fail cleanly if any exist
-- (data can be cleaned in a preceding script if needed).
ALTER TABLE "Supplier" ADD CONSTRAINT "Supplier_businessId_name_key"
    UNIQUE ("businessId", "name");

-- ── Partial unique index: CashMovement income per saleId ──────────────────────
-- Prevents two income CashMovements for the same sale (double-charge guard).
-- Partial: only applies when saleId IS NOT NULL AND type = 'income'.
CREATE UNIQUE INDEX "CashMovement_saleId_income_key"
    ON "CashMovement"("saleId")
    WHERE "saleId" IS NOT NULL AND "type" = 'income';

-- ── CHECK constraints ─────────────────────────────────────────────────────────

ALTER TABLE "SaleItem"
    ADD CONSTRAINT "SaleItem_quantity_positive" CHECK (quantity > 0);

ALTER TABLE "SaleItem"
    ADD CONSTRAINT "SaleItem_unitPrice_nonneg" CHECK ("unitPrice" >= 0);

ALTER TABLE "PaymentIntent"
    ADD CONSTRAINT "PaymentIntent_monto_positive" CHECK (monto > 0);

ALTER TABLE "Sale"
    ADD CONSTRAINT "Sale_totalAmount_nonneg" CHECK ("totalAmount" >= 0);

ALTER TABLE "StockMovement"
    ADD CONSTRAINT "StockMovement_delta_nonzero" CHECK (delta != 0);
