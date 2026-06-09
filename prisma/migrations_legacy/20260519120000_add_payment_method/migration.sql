-- Add paymentMethod to CashMovement for per-method cash register breakdown.
-- Nullable so existing rows remain valid (no default required on existing data).
ALTER TABLE "CashMovement" ADD COLUMN "paymentMethod" TEXT;

-- Mirror the field on Sale for reporting queries that don't need a JOIN.
ALTER TABLE "Sale" ADD COLUMN "paymentMethod" TEXT;
