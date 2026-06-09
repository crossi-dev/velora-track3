-- Migration: add Business.postalCode
-- Adds a nullable text column to store the business's postal code (used as the
-- shipment origin when quoting with Andreani). Separate from the free-text
-- `address` field so the downstream quote call has a clean numeric string.
--
-- DO NOT APPLY via `prisma db execute` automatically.
-- Apply manually against the production DATABASE_URL (Neon) when ready.

ALTER TABLE "Business" ADD COLUMN "postalCode" TEXT;
