-- Migration: Customer(businessId, name) composite index
-- Covers resolveCustomerIdByName: case-insensitive ILIKE on name filtered by
-- businessId. Without this index the query degrades to a full businessId-scoped
-- scan on every payment-agent call that resolves a customer from a free-text name.
-- The existing @@unique([businessId, name]) index does NOT cover ILIKE because
-- unique indexes in Postgres use exact equality; ILIKE bypasses them.
-- This explicit btree index lets Postgres use index scan + filter for ILIKE
-- queries when the name prefix is selective enough (most real-world names are).

CREATE INDEX IF NOT EXISTS "Customer_businessId_name_idx"
  ON "Customer" ("businessId", "name");

-- Migration: BusinessCounter.value Int -> BigInt
-- Int4 overflows at ~2.1B. Invoice sequence numbers, draft counters, and budget
-- counters all increment this column; a busy multi-branch franchise hits the
-- ceiling without this change. USING cast is safe — all existing values fit in bigint.

ALTER TABLE "BusinessCounter"
  ALTER COLUMN "value" TYPE bigint USING "value"::bigint;
