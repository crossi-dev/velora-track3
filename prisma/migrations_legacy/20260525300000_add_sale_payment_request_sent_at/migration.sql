-- Migration: 20260525300000_add_sale_payment_request_sent_at
-- Adds paymentRequestSentAt to Sale for idempotent WhatsApp transfer-payment notifications.
-- Null = not yet sent; stamped on successful send to prevent double-delivery on retries.

ALTER TABLE "Sale" ADD COLUMN "paymentRequestSentAt" TIMESTAMP(3);
