-- Migration: arca_credential_secret_manager
--
-- Changes:
--   1. Make encryptedPassphrase nullable (legacy fallback field).
--   2. Add passphraseSecretName (Secret Manager secretId for the passphrase).
--
-- Backward compatibility:
--   - Existing rows keep their encryptedPassphrase value until the migration
--     script (scripts/migrate-arca-passphrase-to-secret-manager.mjs) runs.
--   - The application falls back to decrypting encryptedPassphrase when
--     passphraseSecretName is NULL, so no downtime is introduced.
--
-- Apply manually against prod:
--   npx prisma db execute --file prisma/migrations/20260521010000_arca_credential_secret_manager/migration.sql

ALTER TABLE "ArcaCredential"
  ALTER COLUMN "encryptedPassphrase" DROP NOT NULL,
  ADD COLUMN "passphraseSecretName" TEXT;
