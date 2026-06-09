-- Migration: add FCM dual-channel push support to PushSubscription
-- Generated: 2026-05-13
-- DO NOT apply automatically — run `npx prisma migrate deploy` after
-- uploading FIREBASE_SERVICE_ACCOUNT_JSON to Cloud Run secrets.

-- AlterTable: add kind (webpush|fcm) + optional FCM token
ALTER TABLE "PushSubscription" ADD COLUMN "fcmToken" TEXT;
ALTER TABLE "PushSubscription" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'webpush';

-- Index for FCM fan-out query: WHERE businessId = ? AND kind = 'fcm' AND expired = false
CREATE INDEX "PushSubscription_businessId_kind_expired_idx"
  ON "PushSubscription"("businessId", "kind", "expired");
