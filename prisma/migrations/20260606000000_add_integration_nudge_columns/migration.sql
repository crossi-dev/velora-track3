-- Migration: 20260606000000_add_integration_nudge_columns
-- Adds integration-nudge tracking columns to Business for the proactive
-- onboarding redesign (spec v4 §14, design approved 2026-06-06).
--
-- firstSaleAt            : timestamp of the business's first confirmed sale.
--                          Gate-release anchor for the MP idle-window (24h).
--                          Null until the first sale commits via the post-commit hook.
--
-- mpNudgeShownAt         : when the MercadoPago integration nudge was shown.
-- mpNudgeDismissedAt     : when the owner dismissed the MP nudge. 48h dismiss gate.
-- whatsappNudgeShownAt   : when the WhatsApp integration nudge was shown.
-- whatsappNudgeDismissedAt : when the owner dismissed the WhatsApp nudge.
-- andreaniNudgeShownAt   : when the Andreani integration nudge was shown.
-- andreaniNudgeDismissedAt : when the owner dismissed the Andreani nudge.
-- arcaNudgeShownAt       : when the ARCA/AFIP integration nudge was shown.
-- arcaNudgeDismissedAt   : when the owner dismissed the ARCA nudge.
--
-- All columns default NULL ("not yet shown") — no backfill needed. Safe to
-- apply against a live database (additive ALTER TABLE only).
--
-- DEPLOY ORDER: apply this migration BEFORE deploying code that reads these
-- columns — else P2021 (column does not exist) at runtime.
--
-- Apply manually against the production DATABASE_URL (Supabase):
--   npx prisma db execute \
--     --file prisma/migrations/20260606000000_add_integration_nudge_columns/migration.sql \
--     --schema prisma/schema.prisma

ALTER TABLE "Business"
  ADD COLUMN IF NOT EXISTS "firstSaleAt"             TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "mpNudgeShownAt"           TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "mpNudgeDismissedAt"       TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "whatsappNudgeShownAt"     TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "whatsappNudgeDismissedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "andreaniNudgeShownAt"     TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "andreaniNudgeDismissedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "arcaNudgeShownAt"         TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "arcaNudgeDismissedAt"     TIMESTAMP(3);
