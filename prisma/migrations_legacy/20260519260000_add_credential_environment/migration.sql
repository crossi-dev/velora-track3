-- Migration: add environment field to ArcaCredential and CourierCredential
--
-- Motivation: per-credential environment selection (production vs homo/sandbox).
-- Existing rows get environment = 'production' — safe because the platform flag
-- ARCA_PRODUCTION/ANDREANI_PRODUCTION was "true" in Cloud Run, so existing
-- credentials were already operating against production endpoints.
--
-- ArcaCredential.environment values: "production" | "homo"
-- CourierCredential.environment values: "production" | "sandbox"
--
-- Both are additive (ADD COLUMN ... DEFAULT ...) — zero risk to existing rows.
-- NOT NULL with default ensures no null reads in application layer.
--
-- DO NOT APPLY via `prisma db execute` automatically.
-- Apply manually against the production DATABASE_URL (Neon) when ready.

ALTER TABLE "ArcaCredential"
  ADD COLUMN "environment" TEXT NOT NULL DEFAULT 'production';

ALTER TABLE "CourierCredential"
  ADD COLUMN "environment" TEXT NOT NULL DEFAULT 'production';
