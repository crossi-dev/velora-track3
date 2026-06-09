-- Migration: add BusinessChannelCredential
-- Per-business (BYOA) credentials for messaging / fulfillment channels:
-- Twilio SMS, Resend email, PedidosYa. Mirrors CourierCredential.
-- Credentials are stored AES-256-GCM encrypted in encryptedCredentials.
-- The UNIQUE constraint on (businessId, provider) ensures one row per
-- provider per business — upserts are safe.
--
-- ADDITIVE migration: creates a NEW table only. Does NOT alter or touch any
-- existing table or data. Safe to apply against a live database.
--
-- Apply manually against the production DATABASE_URL (Supabase) when ready:
--   npx prisma db execute \
--     --file prisma/migrations/20260604020000_add_business_channel_credential/migration.sql \
--     --schema prisma/schema.prisma

CREATE TABLE "BusinessChannelCredential" (
  "id"                   TEXT         NOT NULL,
  "businessId"           TEXT         NOT NULL,
  "provider"             TEXT         NOT NULL,
  "encryptedCredentials" TEXT         NOT NULL,
  "environment"          TEXT         NOT NULL DEFAULT 'production',
  "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"            TIMESTAMP(3) NOT NULL,

  CONSTRAINT "BusinessChannelCredential_pkey" PRIMARY KEY ("id")
);

-- FK to Business — cascade delete so removing a business cleans up its credentials.
ALTER TABLE "BusinessChannelCredential"
  ADD CONSTRAINT "BusinessChannelCredential_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Unique: one credential set per provider per business (makes upserts safe).
CREATE UNIQUE INDEX "BusinessChannelCredential_businessId_provider_key"
  ON "BusinessChannelCredential"("businessId", "provider");
