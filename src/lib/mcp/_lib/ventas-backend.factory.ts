// src/lib/mcp/_lib/ventas-backend.factory.ts — VentasBackend selection via VENTAS_BACKEND env var.
//
// Mirrors catalog-backend.factory.ts exactly:
//   - Reads process.env.VENTAS_BACKEND at CALL TIME (not module-load) so tests and
//     feature flags can toggle without a module reload.
//   - Default is "velora" when unset / blank — safe for all existing deployments.
//   - Fail-loud on unknown values: a typo'd VENTAS_BACKEND must not silently fall back.
//
// Supported backends:
//   "velora"       (default) — VeloraVentasAdapter wrapping the existing ventas-queries functions.
//   "tiendanube"             — TiendanubeVentasAdapter: READ-ONLY adapter for a real
//                              Tiendanube (Nuvemshop) store. Credentials loaded from
//                              BusinessChannelCredential(provider="tiendanube") per tenant.
//                              See tiendanube-ventas.adapter.ts for token setup instructions.
//
// Adding a new backend:
//   1. Implement `src/lib/mcp/_lib/<name>-ventas.adapter.ts` satisfying VentasBackend.
//   2. Add a branch below: case "<name>": return new YourAdapter().
//   3. Add the string to SUPPORTED_BACKENDS.

import type { VentasBackend } from "./ventas-backend.port";
import { VeloraVentasAdapter } from "./velora-ventas.adapter";
import { TiendanubeVentasAdapter } from "./tiendanube-ventas.adapter";

const SUPPORTED_BACKENDS = ["velora", "tiendanube"] as const;
type SupportedBackend = (typeof SUPPORTED_BACKENDS)[number];

/**
 * Returns a VentasBackend instance for the active backend.
 *
 * Resolution order (first non-blank wins):
 *   1. tenantOverride — per-tenant slug from TenantToolConfig (null = not set)
 *   2. VENTAS_BACKEND — global env var
 *   3. "velora"       — hard default
 *
 * Throws on any unrecognised value — fail-loud, not silent-fallback.
 * Existing no-arg callers are unaffected (tenantOverride defaults to undefined).
 */
export function createVentasBackend(tenantOverride?: string | null): VentasBackend {
  // Tenant override wins when present and non-blank; then env; then "velora".
  const raw = (tenantOverride ?? process.env.VENTAS_BACKEND ?? "").trim() || "velora";

  // Validate membership BEFORE the switch so the `never` exhaustiveness check in
  // the default branch stays meaningful (mirrors catalog-backend.factory.ts pattern).
  if (!(SUPPORTED_BACKENDS as readonly string[]).includes(raw)) {
    throw new Error(
      `Unknown VENTAS_BACKEND="${raw}". Supported backends: ${SUPPORTED_BACKENDS.join(", ")}.`,
    );
  }
  const backend = raw as SupportedBackend;

  switch (backend) {
    case "velora":
      return new VeloraVentasAdapter();

    case "tiendanube":
      return new TiendanubeVentasAdapter();

    default: {
      const _exhaustive: never = backend;
      void _exhaustive;
      throw new Error(
        `Unknown VENTAS_BACKEND="${backend}". Supported backends: ${SUPPORTED_BACKENDS.join(", ")}.`,
      );
    }
  }
}
