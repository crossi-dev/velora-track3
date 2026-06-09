-- Migration: add_mp_onboarding_deferred
-- AddColumn: Business.mercadoPagoOnboardingDeferred
--
-- Deploy with: npx prisma migrate deploy
-- (run against the target DATABASE_URL; shadow DB skipped on create-only)

ALTER TABLE "Business" ADD COLUMN "mercadoPagoOnboardingDeferred" BOOLEAN NOT NULL DEFAULT false;
