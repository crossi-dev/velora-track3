-- BYOA (Bring Your Own Account) fields for AFIP/ARCA and Andreani.
--
-- ARCA: instead of uploading a cert, the owner delegates their CUIT to
-- Velora's own ARCA account via "Administrador de Relaciones de Clave Fiscal".
-- arcaDelegationCuit stores the delegated CUIT (canonical format XX-XXXXXXXX-X).
-- arcaDelegationPendingStep: "awaiting_cuit" while the onboarding turn waits
-- for the owner to paste their CUIT back into the chat. Null otherwise.
--
-- Andreani: the owner generates API credentials in developers.andreani.com
-- and pastes the token into chat. Velora encrypts it (AES-256-GCM) before
-- persisting. andreaniApiToken stores the ciphertext. andreaniApiUser is
-- optional metadata. andreaniTokenPendingStep: "awaiting_token" while waiting.
--
-- Apply manually against prod DATABASE_URL:
--   npx prisma db execute --file prisma/migrations/20260525120000_arca_andreani_byoa/migration.sql

ALTER TABLE "Business"
  ADD COLUMN IF NOT EXISTS "arcaDelegationCuit"        TEXT,
  ADD COLUMN IF NOT EXISTS "arcaDelegationPendingStep"  TEXT,
  ADD COLUMN IF NOT EXISTS "andreaniApiToken"           TEXT,
  ADD COLUMN IF NOT EXISTS "andreaniApiUser"            TEXT,
  ADD COLUMN IF NOT EXISTS "andreaniTokenPendingStep"   TEXT;
