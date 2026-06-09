-- Migration: 20260525600000_add_payment_intent_provider_ref_index
--
-- Adds two indexes on PaymentIntent.providerRef so the MP webhook fallback query
-- (findFirst({ where: { providerRef } })) does not cause a full table scan.
-- The fallback path fires when the incoming notification lacks ?businessId= in the
-- notification URL (Checkout Pro preferences created before the query-param fix).
--
-- @@index([providerRef])                — bare lookup when businessId unknown
-- @@index([businessId, providerRef])    — composite lookup when businessId is known

CREATE INDEX CONCURRENTLY IF NOT EXISTS "PaymentIntent_providerRef_idx"
  ON "PaymentIntent" ("providerRef");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "PaymentIntent_businessId_providerRef_idx"
  ON "PaymentIntent" ("businessId", "providerRef");
