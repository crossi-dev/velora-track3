-- Add description and customerName to PaymentIntent for data integrity.
--
-- H1 fix: description was sent to MercadoPago as the preference title but never
--         persisted on the row. After creation there was no way to know what the
--         payment was for. Now stored as TEXT (free-form, no length cap — MP
--         accepts up to 256 chars; validation is upstream in the use-case input).
--
-- H4 fix: customerName was accepted in use-case input and stored only as
--         matchedCustomerId FK. When the customer wasn't found in DB the name
--         was lost. Now stored as TEXT alongside the FK so anonymous-customer
--         cobros remain auditable.
--
-- Both columns are nullable for backward compatibility with existing rows.
-- IF NOT EXISTS guards ensure re-running this migration is safe.
ALTER TABLE "PaymentIntent" ADD COLUMN IF NOT EXISTS "description"  TEXT;
ALTER TABLE "PaymentIntent" ADD COLUMN IF NOT EXISTS "customerName" TEXT;
