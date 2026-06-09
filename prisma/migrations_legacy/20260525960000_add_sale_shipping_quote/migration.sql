-- Migration: 20260525960000_add_sale_shipping_quote
--
-- Adds two nullable columns to Sale for capturing Andreani shipping cost
-- PRE-PAGO (async payment methods: qr, transferencia).
--
-- Design intent:
--   - shippingQuoteCost: cheapest Andreani quote returned by shipment.quote call
--     in the quote-only path of triggerLogisticaIfShippingData. Used by:
--       1. resolveSaleItemsForPreference → freight line in MP Checkout Pro preference.
--       2. trigger-fiscal-receipt post-confirm → shippingLine in InvoicePayload → PDF row.
--   - shippingQuoteCourier: label for the freight line (e.g. "Andreani").
--
-- Sync payment methods (efectivo, tarjeta) skip the quote path entirely (full
-- create flow unchanged). Both columns remain NULL for those rows.
--
-- Applied against: Supabase pgbouncer transaction mode pooler.
-- Safe: both columns are nullable; no back-fill required.

ALTER TABLE "Sale"
  ADD COLUMN IF NOT EXISTS "shippingQuoteCost"    DECIMAL(14,2),
  ADD COLUMN IF NOT EXISTS "shippingQuoteCourier" TEXT;
