-- Migration: 20260526T3_add_payment_intent_items
-- Adds structured line items column to PaymentIntent for standalone PIs
-- (saleId = null — cobros sueltos via "generá un link de pago" chat intent).
--
-- Canonical item shape:
--   Array<{ productName: string; quantity: number; unitPrice: number; subtotal: number }>
--
-- Nullable so existing rows keep working — PDF helper falls back to
-- "Pago recibido" when null (backward compat).
--
-- Ref: Stripe PaymentIntent metadata §structured-data, MP Preference.items schema,
--      Postgres JSON best practices 2026 (typed-at-write, opaque-in-DB).

ALTER TABLE "PaymentIntent"
  ADD COLUMN IF NOT EXISTS "items" JSONB;
