-- AddColumn: matchedCustomerId on PaymentIntent
-- Persists the NLU-resolved customer ID so the post-confirm hook can
-- send a WhatsApp receipt without requiring a saleId.
ALTER TABLE "PaymentIntent" ADD COLUMN IF NOT EXISTS "matchedCustomerId" TEXT;
