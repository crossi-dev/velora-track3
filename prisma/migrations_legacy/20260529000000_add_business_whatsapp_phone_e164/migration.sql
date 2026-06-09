-- Migration: add_business_whatsapp_phone_e164
-- Adds the whatsappBusinessPhoneE164 column already declared in prisma/schema.prisma.
-- The services-status route was 500-ing because this column is referenced in code
-- but was missing from the prod DB. IF NOT EXISTS makes it idempotent.
-- Apply manually: npx prisma db execute --file prisma/migrations/20260529000000_add_business_whatsapp_phone_e164/migration.sql

ALTER TABLE "Business" ADD COLUMN IF NOT EXISTS "whatsappBusinessPhoneE164" TEXT;
