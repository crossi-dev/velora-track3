-- Migration: 20260526600000_add_invoice_fiscal_qr_url
-- Adds fiscalQrUrl to Invoice for AFIP RG 4291/2018 QR code compliance.
-- The URL encodes invoice data as base64 JSON and is stored after a successful
-- real WSFE CAE emission. Null for sandbox/non-fiscal receipts.
-- The PDF builder reads this column to render the mandatory QR image.

ALTER TABLE "Invoice"
  ADD COLUMN IF NOT EXISTS "fiscalQrUrl" TEXT;
