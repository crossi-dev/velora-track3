-- Migration: add CourierCredential
-- Per-business courier API credentials (Andreani, OCA, Correo Argentino).
-- Credentials are stored AES-256-GCM encrypted in encryptedCredentials.
-- The UNIQUE constraint on (businessId, provider) ensures one row per
-- provider per business — upserts are safe.
--
-- DO NOT APPLY via `prisma db execute` automatically.
-- Apply manually against the production DATABASE_URL (Neon) when ready.

CREATE TABLE "CourierCredential" (
  "id"                   TEXT         NOT NULL,
  "businessId"           TEXT         NOT NULL,
  "provider"             TEXT         NOT NULL,
  "encryptedCredentials" TEXT         NOT NULL,
  "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"            TIMESTAMP(3) NOT NULL,

  CONSTRAINT "CourierCredential_pkey" PRIMARY KEY ("id")
);

-- FK to Business — cascade delete so removing a business cleans up credentials.
ALTER TABLE "CourierCredential"
  ADD CONSTRAINT "CourierCredential_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Unique: one credential set per courier per business.
CREATE UNIQUE INDEX "CourierCredential_businessId_provider_key"
  ON "CourierCredential"("businessId", "provider");
