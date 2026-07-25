// src/lib/mcp/_lib/tenant-tool-config.ts — Per-tenant backend override resolver.
//
// Fetches the TenantToolConfig row for a given businessId and returns a
// TenantBackendMap where each field is the tenant override slug (or null when
// no override is set for that pack).
//
// Resolution contract (algebraically identical to today for all existing tenants):
//   1. TenantToolConfig row absent  → every field is null → each factory reads
//      its env var → falls back to "velora". Same as current behaviour.
//   2. TenantToolConfig row present → null column → same as (1) for that pack.
//   3. TenantToolConfig row present → non-null column → factory receives the
//      slug as tenantOverride; env var is ignored for that pack.
//
// One DB query per MCP request, indexed by businessId (@unique). At ~1 ms cold,
// this is negligible compared to the tool execution latency.

import { prisma } from "@/lib/prisma";

/** Per-pack backend override slugs. Null means "use the global env var". */
export interface TenantBackendMap {
  catalog:   string | null;
  customer:  string | null;
  fiscal:    string | null;
  logistica: string | null;
  messaging: string | null;
  payments:  string | null;
  reportes:  string | null;
  sales:     string | null;
  supplier:  string | null;
  ventas:    string | null;
}

/**
 * Resolves the per-tenant backend map for the given businessId.
 *
 * Returns all-null when no TenantToolConfig row exists — factories will
 * fall back to their global env var (and then to "velora"), which is
 * byte-for-byte identical to today's behaviour for all existing tenants.
 */
export async function resolveTenantBackendMap(
  businessId: string,
): Promise<TenantBackendMap> {
  const cfg = await prisma.tenantToolConfig.findUnique({
    where: { businessId },
    select: {
      catalog:   true,
      customer:  true,
      fiscal:    true,
      logistica: true,
      messaging: true,
      payments:  true,
      supplier:  true,
      ventas:    true,
      // sales and reportes are app-layer fields only — not yet in the DB schema.
      // They are resolved from env vars (SALES_BACKEND / REPORTES_BACKEND) or
      // "velora" default. When a DB column is added via migration, remove these
      // comments and add the fields to the select + return below.
    },
  });

  return {
    catalog:   cfg?.catalog   ?? null,
    customer:  cfg?.customer  ?? null,
    fiscal:    cfg?.fiscal    ?? null,
    logistica: cfg?.logistica ?? null,
    messaging: cfg?.messaging ?? null,
    payments:  cfg?.payments  ?? null,
    // sales / reportes: no DB column yet — always null (falls back to env var / "velora").
    reportes:  null,
    sales:     null,
    supplier:  cfg?.supplier  ?? null,
    ventas:    cfg?.ventas    ?? null,
  };
}
