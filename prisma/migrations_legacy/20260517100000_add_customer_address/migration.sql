-- Add shipping-address columns to Customer.
-- All three are nullable so existing rows remain backward compatible
-- without a data migration step.
-- address:    free-text street address (e.g. "Olascoaga 1959").
-- postalCode: explicit postal code string — required by Andreani.
--             Kept as a separate TEXT column (not derivable from city).
-- city:       city name (e.g. "Mendoza").
ALTER TABLE "Customer" ADD COLUMN "address"    TEXT;
ALTER TABLE "Customer" ADD COLUMN "postalCode" TEXT;
ALTER TABLE "Customer" ADD COLUMN "city"       TEXT;
