-- Additive migration: add reconcileFastTrack flag to PaymentIntent.
-- Industry standard: Stripe process-undelivered-events pattern (2026).
-- https://docs.stripe.com/webhooks/process-undelivered-events
--
-- When the MP webhook handler throws, it sets this flag so the 1-min reconcile
-- cron picks up the PI on the next tick, bypassing the 5-min staleness filter.
-- Cleared to false after successful confirm.
-- DEFAULT false ensures zero downtime — existing rows are unaffected.

ALTER TABLE "PaymentIntent"
  ADD COLUMN IF NOT EXISTS "reconcileFastTrack" BOOLEAN NOT NULL DEFAULT false;
