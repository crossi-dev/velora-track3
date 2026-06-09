// src/lib/mcp/_lib/catalog-backend.factory.ts — CatalogBackend selection via CATALOG_BACKEND env var.
//
// Mirrors engine-factory.ts exactly:
//   - Reads process.env.CATALOG_BACKEND at CALL TIME (not module-load) so tests and
//     feature flags can toggle without a module reload.
//   - Default is "velora" when unset / blank — safe for all existing deployments.
//   - Fail-loud on unknown values: a typo'd CATALOG_BACKEND must not silently fall back.
//
// Supported backends:
//   "velora"      (default) — VeloraCatalogAdapter wrapping the existing use-case instances.
//   "tiendanube"            — TiendanubeCatalogAdapter for a connected Tiendanube (Nuvemshop) store.
//                            Note: stock_load is not supported on Tiendanube (returns errResponse).
//                            Credentials via BusinessChannelCredential(provider="tiendanube").
//
// Adding a new backend:
//   1. Implement `src/lib/mcp/_lib/<name>-catalog.adapter.ts` satisfying CatalogBackend.
//   2. Add a branch below: case "<name>": return new YourAdapter().
//   3. Add the string to SUPPORTED_BACKENDS.

import type { CatalogBackend } from "./catalog-backend.port";
import { VeloraCatalogAdapter } from "./velora-catalog.adapter";
import { TiendanubeCatalogAdapter } from "./tiendanube-catalog.adapter";

const SUPPORTED_BACKENDS = ["velora", "tiendanube"] as const;
type SupportedBackend = (typeof SUPPORTED_BACKENDS)[number];

/**
 * Returns a CatalogBackend instance for the active backend.
 *
 * Resolution order (first non-blank wins):
 *   1. tenantOverride  — per-tenant slug from TenantToolConfig (null = not set)
 *   2. CATALOG_BACKEND — global env var
 *   3. "velora"        — hard default
 *
 * Throws on any unrecognised value — fail-loud, not silent-fallback.
 * Existing no-arg callers are unaffected (tenantOverride defaults to undefined).
 */
export function createCatalogBackend(tenantOverride?: string | null): CatalogBackend {
  // Tenant override wins when present and non-blank; then env; then "velora".
  const raw = (tenantOverride ?? process.env.CATALOG_BACKEND ?? "").trim() || "velora";

  // Validate membership BEFORE the switch so the `never` exhaustiveness check in
  // the default branch stays meaningful (mirrors engine-factory.ts S3 JD finding).
  if (!(SUPPORTED_BACKENDS as readonly string[]).includes(raw)) {
    throw new Error(
      `Unknown CATALOG_BACKEND="${raw}". Supported backends: ${SUPPORTED_BACKENDS.join(", ")}.`,
    );
  }
  const backend = raw as SupportedBackend;

  switch (backend) {
    case "velora":
      return new VeloraCatalogAdapter();

    case "tiendanube":
      return new TiendanubeCatalogAdapter();

    default: {
      const _exhaustive: never = backend;
      void _exhaustive;
      throw new Error(
        `Unknown CATALOG_BACKEND="${backend}". Supported backends: ${SUPPORTED_BACKENDS.join(", ")}.`,
      );
    }
  }
}
