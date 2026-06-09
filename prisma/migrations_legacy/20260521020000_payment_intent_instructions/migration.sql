-- Add paymentInstructions column to PaymentIntent for alias/CBU transfer instructions.
-- Used by AliasCbuAdapter to persist transfer details (alias + amount) so the
-- WhatsApp send chip can retrieve them without a checkoutUrl.
ALTER TABLE "PaymentIntent" ADD COLUMN "paymentInstructions" TEXT;
