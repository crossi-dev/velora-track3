-- Migration: 20260525400000_add_invoice_cae_fields
-- Adds AFIP/ARCA fiscal fields to Invoice (RG 2485 / WSFE FECAESolicitar).
-- caeCode: 14-digit CAE returned by FECAESolicitar (nullable for non-fiscal receipts).
-- caeFchVto: CAE expiry date (YYYYMMDD from AFIP, stored as timestamptz midnight UTC).
-- fiscalTipo: WSFE tipoComprobante code (1=A, 6=B, 11=C).
-- fiscalPtoVta: punto de venta used to emit.
-- fiscalNumero: nroCbte returned by WSFE (sequential per tipo+ptoVta).
-- fiscalEmittedAt: timestamp of the successful WSFE call.
-- Index on (businessId, fiscalTipo, fiscalPtoVta, fiscalNumero) for idempotency guard.

ALTER TABLE "Invoice"
  ADD COLUMN IF NOT EXISTS "caeCode"         TEXT,
  ADD COLUMN IF NOT EXISTS "caeFchVto"       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "fiscalTipo"      INTEGER,
  ADD COLUMN IF NOT EXISTS "fiscalPtoVta"    INTEGER,
  ADD COLUMN IF NOT EXISTS "fiscalNumero"    INTEGER,
  ADD COLUMN IF NOT EXISTS "fiscalEmittedAt" TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS "Invoice_businessId_fiscalTipo_fiscalPtoVta_fiscalNumero_idx"
  ON "Invoice" ("businessId", "fiscalTipo", "fiscalPtoVta", "fiscalNumero");
