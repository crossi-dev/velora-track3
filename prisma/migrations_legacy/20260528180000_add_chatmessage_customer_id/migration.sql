-- Migration: add_chatmessage_customer_id
--
-- Adds:
--   1. ChatMessage.customerId — anchor for Customer Agent thread continuity.
--   2. Index on (businessId, customerId, createdAt) for the worker's recent-turn lookup.
--
-- Nullable: pre-existing owner/employee chats remain valid (customerId null).
-- FK: ON DELETE SET NULL so customer hard-deletes don't cascade-wipe history.

ALTER TABLE "ChatMessage" ADD COLUMN "customerId" TEXT;
CREATE INDEX "ChatMessage_businessId_customerId_createdAt_idx"
  ON "ChatMessage"("businessId", "customerId", "createdAt");
