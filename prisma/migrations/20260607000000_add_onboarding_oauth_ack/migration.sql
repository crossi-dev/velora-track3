-- Migration: 20260607000000_add_onboarding_oauth_ack
-- Adds OnboardingOauthAck — a dedicated dedup token for the OAuth re-entry ack
-- (design §6/§14.8). Separate from ChatMessage so the token is invisible to
-- chat-history queries and to the recentAlerts Supervisor prompt injection.
-- slotDate (YYYY-MM-DD ART/UTC-3) allows reconnect to re-ack the next ART day.

CREATE TABLE "OnboardingOauthAck" (
  "id"          TEXT        NOT NULL,
  "businessId"  TEXT        NOT NULL,
  "integration" TEXT        NOT NULL,
  "slotDate"    TEXT        NOT NULL,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "OnboardingOauthAck_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OnboardingOauthAck_businessId_integration_slotDate_key"
  ON "OnboardingOauthAck"("businessId", "integration", "slotDate");

CREATE INDEX "OnboardingOauthAck_businessId_createdAt_idx"
  ON "OnboardingOauthAck"("businessId", "createdAt");

ALTER TABLE "OnboardingOauthAck"
  ADD CONSTRAINT "OnboardingOauthAck_businessId_fkey"
  FOREIGN KEY ("businessId")
  REFERENCES "Business"("id")
  ON DELETE CASCADE
  ON UPDATE CASCADE;
