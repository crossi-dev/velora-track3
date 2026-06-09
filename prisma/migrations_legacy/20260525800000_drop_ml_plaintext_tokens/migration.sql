-- Migration: drop plaintext token columns from MlCredential.
--
-- PREREQUISITE: run `node scripts/migrate-ml-plaintext-to-ciphertext.mjs` against
-- prod BEFORE applying this migration. The script encrypts any legacy rows where
-- accessTokenCiphertext IS NULL. If this migration runs first, those rows lose
-- their tokens irreversibly.
--
-- MercadoLibre is encajonado (project_mercadolibre_encajonado) — zero active rows
-- expected in prod. Verification query before applying:
--   SELECT COUNT(*) FROM "MlCredential" WHERE "accessTokenCiphertext" IS NULL;
--   -- must return 0 before continuing.
--
-- Mirrors 20260519350000_drop_mp_plaintext (same pattern applied to ML).

ALTER TABLE "MlCredential" DROP COLUMN "accessToken";
ALTER TABLE "MlCredential" DROP COLUMN "refreshToken";
