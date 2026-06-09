-- Migration: 20260525200000_onboarding_redesign
-- Adds two flags for the onboarding redesign (T1-T4 pre-aha flow).
--
-- skippedCatalog      : owner tapped "No tengo todavía" at the import-first T3 turn.
-- firstSalePromptShown: T4 guided first-sale prompt was already shown (show once only).
--
-- Apply manually against prod DATABASE_URL:
--   npx prisma db execute --file prisma/migrations/20260525200000_onboarding_redesign/migration.sql

ALTER TABLE "Business"
  ADD COLUMN IF NOT EXISTS "skippedCatalog"         BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "firstSalePromptShown"    BOOLEAN NOT NULL DEFAULT false;
