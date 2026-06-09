-- MpConnection: add encrypted token columns (slice A — envelope encryption).
--
-- Strategy: additive migration — add ciphertext columns alongside the existing
-- plaintext columns. Application code writes ciphertext-only on all new
-- insert/update paths; reads use a fallback chain (ciphertext → plaintext).
-- The plaintext columns are intentionally NOT dropped here so that any rows
-- written before the app deploy (and any failed-deploy rollback) still read
-- cleanly. They can be dropped in a future cleanup migration once all rows
-- have been re-encrypted (slice A+1).
--
-- Aditiva: dos columnas nuevas. NO toca data existente. Sin downtime.

ALTER TABLE "MpConnection"
  ADD COLUMN IF NOT EXISTS "accessTokenCiphertext"  TEXT,
  ADD COLUMN IF NOT EXISTS "refreshTokenCiphertext" TEXT;
