-- Migration: add_waba_connection
-- Step 1.5b — Capability-Aware Orchestration Backbone
--
-- Adds:
--   1. Business.whatsappBusinessPhoneE164 — lower-tier capability signal for
--      businesses that have not completed Meta Embedded Signup yet.
--   2. WabaConnection table — per-tenant WhatsApp Business Account credentials
--      following the Meta Tech Provider model.
--
-- Sources:
--   Meta Tech Provider: https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-customers-as-a-tech-provider
--   Meta access tokens: https://developers.facebook.com/documentation/business-messaging/whatsapp/access-tokens/
--   Mirror of existing MpConnection pattern in Velora schema.

-- 1. Add lower-tier WhatsApp phone column to Business (nullable, no default needed).
ALTER TABLE "Business" ADD COLUMN "whatsappBusinessPhoneE164" TEXT;

-- 2. Create WabaConnection table.
CREATE TABLE "WabaConnection" (
    "id"                    TEXT NOT NULL,
    "businessId"            TEXT NOT NULL,
    "wabaId"                TEXT NOT NULL,
    "phoneNumberId"         TEXT NOT NULL,
    "accessTokenCiphertext" TEXT NOT NULL,
    "connectedAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastVerifiedAt"        TIMESTAMP(3),
    "createdAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"             TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WabaConnection_pkey" PRIMARY KEY ("id")
);

-- 3. Unique constraint: one WABA per business.
CREATE UNIQUE INDEX "WabaConnection_businessId_key" ON "WabaConnection"("businessId");

-- 4. Index on phoneNumberId for inbound routing lookups.
CREATE INDEX "WabaConnection_phoneNumberId_idx" ON "WabaConnection"("phoneNumberId");

-- 5. Foreign key: WabaConnection.businessId → Business.id (cascade delete).
ALTER TABLE "WabaConnection" ADD CONSTRAINT "WabaConnection_businessId_fkey"
    FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
