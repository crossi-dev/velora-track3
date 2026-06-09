-- Migration: add TA cache columns to ArcaCredential for cross-instance ticket reuse.
-- Apply manually: npx prisma db execute --file prisma/migrations/20260520040000_add_arca_ta_cache/migration.sql
ALTER TABLE "ArcaCredential"
    ADD COLUMN "cachedToken"     TEXT,
    ADD COLUMN "cachedSign"      TEXT,
    ADD COLUMN "cachedExpiresAt" TIMESTAMPTZ;
