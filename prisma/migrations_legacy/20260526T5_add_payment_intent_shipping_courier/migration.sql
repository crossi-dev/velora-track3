-- Migration: 20260526T5_add_payment_intent_shipping_courier
-- Adds shippingCourier column to PaymentIntent so the courier name is stored
-- at create time instead of being hardcoded "Andreani" in PDF helpers.
--
-- Today the only active courier is "andreani". Existing rows are backfilled
-- so that notify-customer-on-confirm.ts and trigger-fiscal-receipt.pdf.ts
-- continue to render the same text for PIs that already have shippingCostARS set.
--
-- Future couriers (OCA, etc.) just write their slug at PI create time.
-- Pattern: Shopify multi-carrier shipping 2026 — courier identifier stored
-- alongside shipment cost, not derived from a global constant.

ALTER TABLE "PaymentIntent"
  ADD COLUMN IF NOT EXISTS "shippingCourier" TEXT;

-- Backfill: rows that have a shipping cost but no courier get "andreani".
-- (The only PI with shipping cost today is the Andreani path.)
UPDATE "PaymentIntent"
  SET "shippingCourier" = 'andreani'
  WHERE "shippingCostARS" IS NOT NULL
    AND "shippingCourier" IS NULL;
