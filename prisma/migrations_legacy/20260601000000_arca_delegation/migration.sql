-- Migration: 20260601000000_arca_delegation
-- Adds delegation fields to ArcaCredential.
--
-- Purpose: allow merchants to delegate the WSFE web service to Velora's provider
-- CUIT via AFIP Administrador de Relaciones. When isProviderDelegation=true, the
-- emission path uses Velora's provider cert (env VELORA_PROVIDER_CERT_GCS_PATH)
-- instead of a per-merchant cert. The merchant's CUIT is still stored in `cuit`
-- and used as <ar:Cuit> (represented party) in WSFE Auth.
--
-- DO NOT apply automatically — run manually against prod:
--   npx prisma db execute --file prisma/migrations/20260601000000_arca_delegation/migration.sql
--
-- Additive only — no data loss, no column drops, safe to apply to existing rows.
-- Existing rows get isProviderDelegation=false (default) and providerCuit=NULL.

ALTER TABLE "ArcaCredential"
  ADD COLUMN IF NOT EXISTS "isProviderDelegation" BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE "ArcaCredential"
  ADD COLUMN IF NOT EXISTS "providerCuit" TEXT;
