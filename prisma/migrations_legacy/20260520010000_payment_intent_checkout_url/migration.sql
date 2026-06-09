-- AlterTable: add checkoutUrl column to PaymentIntent
-- Nullable so existing rows are not affected.
ALTER TABLE "PaymentIntent" ADD COLUMN "checkoutUrl" TEXT;
