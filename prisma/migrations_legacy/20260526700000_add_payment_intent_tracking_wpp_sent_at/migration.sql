-- AlterTable: add trackingWppSentAt to PaymentIntent
-- Atomic claim stamp for sendCustomerTrackingWpp idempotency.
-- updateMany WHERE trackingWppSentAt IS NULL ensures at-most-once delivery
-- across webhook retries and cron replay (mirrors comprobanteSentAt pattern).
ALTER TABLE "PaymentIntent" ADD COLUMN "trackingWppSentAt" TIMESTAMP(3);
