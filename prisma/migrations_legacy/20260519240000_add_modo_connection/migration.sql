-- Migration: add ModoConnection
-- Per-business MODO payment credentials (bring-your-own-account harness).
-- Credentials are stored AES-256-GCM encrypted in encryptedCredentials.
-- The UNIQUE constraint on businessId ensures one credential set per business.
--
-- DO NOT APPLY via `prisma db execute` automatically.
-- Apply manually against the production DATABASE_URL (Neon) when ready.

CREATE TABLE "ModoConnection" (
  "id"                   TEXT         NOT NULL,
  "businessId"           TEXT         NOT NULL,
  "encryptedCredentials" TEXT         NOT NULL,
  "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"            TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ModoConnection_pkey" PRIMARY KEY ("id")
);

-- FK to Business — cascade delete so removing a business cleans up credentials.
ALTER TABLE "ModoConnection"
  ADD CONSTRAINT "ModoConnection_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Unique: one MODO credential set per business.
CREATE UNIQUE INDEX "ModoConnection_businessId_key"
  ON "ModoConnection"("businessId");
