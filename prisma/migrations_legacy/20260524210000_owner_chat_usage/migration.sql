-- OwnerChatUsage — daily message counter per business, keyed by ART date string.
-- Used to enforce the free-tier daily message cap on /api/business-assistant.
-- Testers (TESTER_EMAILS env list) bypass the increment entirely so their
-- limit is effectively infinite.
CREATE TABLE "OwnerChatUsage" (
  "id"         TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "date"       TEXT NOT NULL,
  "count"      INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "OwnerChatUsage_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "OwnerChatUsage_businessId_fkey"
    FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "OwnerChatUsage_businessId_date_key" ON "OwnerChatUsage"("businessId", "date");
CREATE INDEX "OwnerChatUsage_businessId_date_idx" ON "OwnerChatUsage"("businessId", "date");
