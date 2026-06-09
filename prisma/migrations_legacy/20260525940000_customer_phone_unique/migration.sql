-- Migration: 20260525940000_customer_phone_unique
-- Adds a partial unique index on (businessId, phone) for the Customer table,
-- enforcing that no two customers in the same business share a phone number.
-- NULL phones are intentionally excluded: a customer with no phone must still
-- be createable without violating the constraint.
-- Standard reference: Postgres docs §11.8 "Partial Indexes"; same pattern used
-- by Stripe Sigma and QuickBooks Online customer dedup.

CREATE UNIQUE INDEX "Customer_businessId_phone_unique"
  ON "Customer"("businessId", "phone")
  WHERE "phone" IS NOT NULL;
