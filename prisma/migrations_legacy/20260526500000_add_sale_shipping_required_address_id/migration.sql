-- Migration: add shippingRequired + shippingAddressId to Sale
-- Context: register_promesa_sale use-case must persist shipping metadata on the Sale row
-- so that notify-customer-on-confirm + PDF builder can discriminate freight as a
-- separate line item. shippingRequired mirrors the PaymentIntent pattern.
-- shippingAddressId is a nullable opaque string referencing a customer address record
-- (no FK target in current schema — stored as plain text for forward-compat).

ALTER TABLE "Sale"
  ADD COLUMN IF NOT EXISTS "shippingRequired"   BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "shippingAddressId"  TEXT;
