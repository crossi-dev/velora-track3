-- Migration: 20260602000000_add_tenant_tool_config
-- Adds TenantToolConfig table for per-tenant MCP tool-pack backend overrides.
--
-- Purpose: allow each Business (tenant) to route individual MCP tool packs to
-- a different backend system (e.g. "fudo", "pedidosya") without affecting any
-- other tenant. Null column = fall back to the global env var (CATALOG_BACKEND,
-- FISCAL_BACKEND, etc.), which defaults to "velora". An absent row = all nulls
-- = all env var = identical behaviour to today for every existing tenant.
--
-- DO NOT apply automatically — run manually against prod:
--   npx prisma db execute --file prisma/migrations/20260602000000_add_tenant_tool_config/migration.sql
--
-- Additive only — new table, new nullable relation on Business. Zero risk to
-- existing rows. No data loss. Safe to apply with zero downtime.

CREATE TABLE IF NOT EXISTS "TenantToolConfig" (
    "id"         TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "catalog"    TEXT,
    "customer"   TEXT,
    "fiscal"     TEXT,
    "logistica"  TEXT,
    "messaging"  TEXT,
    "payments"   TEXT,
    "promesa"    TEXT,
    "supplier"   TEXT,
    "ventas"     TEXT,
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"  TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TenantToolConfig_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "TenantToolConfig_businessId_key"
    ON "TenantToolConfig"("businessId");

ALTER TABLE "TenantToolConfig"
    ADD CONSTRAINT "TenantToolConfig_businessId_fkey"
    FOREIGN KEY ("businessId")
    REFERENCES "Business"("id")
    ON DELETE CASCADE
    ON UPDATE CASCADE;
