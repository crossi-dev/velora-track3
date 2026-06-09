-- Migration: rename labelPdfPath column semantics — store GCS path only, not signed URL
-- Fixes CRIT-1: signed URLs (15-min TTL) were persisted to DB. After expiry, any consumer
-- (UI, API, WhatsApp) gets a 403. Fix: store the raw GCS object key; generate fresh signed
-- URL on-demand in the API layer (getAndreaniLabelSignedUrl helper in r2.ts).
-- No column rename needed — labelPdfPath column name stays; only the stored value changes.
-- Existing rows that contain a signed URL will return 403 after 15 min; no backfill needed
-- (they were already expiring). New rows will store bare GCS paths like:
--   pdfs/label/{businessId}/{trackingNumber}.pdf
-- Mock rows store the Andreani sandbox URL unchanged (no GCS key for mocks).

-- No DDL change required: column type (TEXT nullable) is unchanged.
-- This migration is a marker/documentation commit for the semantic change.
SELECT 1; -- no-op DDL anchor so Prisma migration engine records this migration
