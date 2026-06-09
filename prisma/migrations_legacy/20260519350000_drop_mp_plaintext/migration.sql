-- Migration: drop plaintext token columns from MpConnection.
--
-- PREREQUISITE: run `node scripts/migrate-mp-plaintext-tokens.mjs` against prod
-- BEFORE applying this migration. The script encrypts any legacy rows that still
-- have accessTokenCiphertext IS NULL. If this migration runs first, those rows
-- lose their tokens irreversibly.
--
-- Verification query (run on prod before applying):
--   SELECT COUNT(*) FROM "MpConnection" WHERE "accessTokenCiphertext" IS NULL;
--   -- must return 0 before continuing.
--
-- The plaintext columns were deprecated in commit 8a50e655 (encryption migration).
-- New writes already use only *Ciphertext columns. The `""` default was a schema
-- constraint workaround while both columns coexisted.

ALTER TABLE "MpConnection" DROP COLUMN "accessToken";
ALTER TABLE "MpConnection" DROP COLUMN "refreshToken";
