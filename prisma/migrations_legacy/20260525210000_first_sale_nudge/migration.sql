-- Migration: 20260525210000_first_sale_nudge
-- Adds two fields to Business for the 24h first-sale re-engagement nudge.
--
-- firstSalePromptShownAt : timestamp of when T4 (first-sale prompt) was shown.
--                          Used by the cron job to calculate the 24h eligibility window.
-- firstSaleNudgeSent     : boolean — true after the nudge ChatMessage was injected.
--                          Prevents duplicate nudges if the cron runs while the owner
--                          still hasn't made their first sale.
--
-- Apply manually against prod DATABASE_URL:
--   npx prisma db execute --file prisma/migrations/20260525210000_first_sale_nudge/migration.sql

ALTER TABLE "Business"
  ADD COLUMN IF NOT EXISTS "firstSalePromptShownAt" TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "firstSaleNudgeSent"     BOOLEAN NOT NULL DEFAULT false;
