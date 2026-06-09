-- Migration: add paymentLinkSentAt to PaymentIntent
-- Atomic-claim stamp for send-customer-payment-link idempotency.
-- Mirrors trackingWppSentAt / comprobanteSentAt patterns throughout the codebase.
-- Apply manually against prod: npx prisma db execute --file <this file>

ALTER TABLE "PaymentIntent" ADD COLUMN "paymentLinkSentAt" TIMESTAMP(3);
