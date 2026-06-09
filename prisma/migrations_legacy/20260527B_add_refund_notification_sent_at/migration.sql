-- Migration: add refundNotificationSentAt to PaymentIntent, undoNotificationSentAt to Sale
-- Atomic-claim stamps for customer reverse-cascade WPP idempotency.
-- Mirrors trackingWppSentAt / comprobanteSentAt / paymentLinkSentAt patterns.
-- Apply manually against prod:
--   npx prisma db execute --file prisma/migrations/20260527B_add_refund_notification_sent_at/migration.sql --schema prisma/schema.prisma

ALTER TABLE "PaymentIntent" ADD COLUMN "refundNotificationSentAt" TIMESTAMP(3);
ALTER TABLE "Sale" ADD COLUMN "undoNotificationSentAt" TIMESTAMP(3);
