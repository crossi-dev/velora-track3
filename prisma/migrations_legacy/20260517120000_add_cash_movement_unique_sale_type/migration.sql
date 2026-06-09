-- Add a partial unique index on CashMovement(saleId, type) WHERE saleId IS NOT NULL.
-- Prevents duplicate cash-movement rows of the same type for the same sale
-- (e.g. two "sale" entries for the same saleId after a retry storm).
-- Prisma's DSL cannot express partial indexes; this migration captures the constraint
-- that the schema comment and domain contract require.
-- The WHERE clause limits the uniqueness to rows tied to a sale — free-standing
-- manual movements (saleId IS NULL) remain unrestricted.
CREATE UNIQUE INDEX "CashMovement_saleId_type_key"
  ON "CashMovement" ("saleId", "type")
  WHERE "saleId" IS NOT NULL;
