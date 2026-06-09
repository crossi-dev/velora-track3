-- AlterTable: add lastSyncAt and lastSyncResult to MlCredential
-- These fields track the most recent catalog.sync execution result
-- so the Integraciones UI can show "X productos sync'd on [date]".

ALTER TABLE "MlCredential" ADD COLUMN "lastSyncAt" TIMESTAMP(3);
ALTER TABLE "MlCredential" ADD COLUMN "lastSyncResult" JSONB;
