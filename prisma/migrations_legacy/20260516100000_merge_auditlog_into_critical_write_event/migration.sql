-- Migration: merge AuditLog into CriticalWriteEvent
-- Date: 2026-05-16
-- Reason: Two overlapping audit-logging systems unified into one.
--   AuditLog had richer diff fields (inputJson / beforeJson / afterJson) but no
--   cleanup cron and only ~5 call sites.  CriticalWriteEvent had ~29 call sites
--   and an existing 90-day TTL cron.  The diff fields are absorbed as nullable
--   columns so existing CriticalWriteEvent rows are unaffected.
--
-- Order: ADD nullable columns first (non-destructive), then DROP TABLE.
-- AuditLog rows are disposable test data — no backfill needed.
--
-- DO NOT apply with `prisma migrate dev` (Neon shadow-DB is broken).
-- Apply manually: psql $DATABASE_URL -f this_file.sql

-- Step 1: Add nullable diff fields to CriticalWriteEvent
ALTER TABLE "CriticalWriteEvent"
  ADD COLUMN IF NOT EXISTS "inputJson"  TEXT,
  ADD COLUMN IF NOT EXISTS "beforeJson" TEXT,
  ADD COLUMN IF NOT EXISTS "afterJson"  TEXT;

-- Step 2: Drop the AuditLog table (rows are disposable test data)
DROP TABLE IF EXISTS "AuditLog";
