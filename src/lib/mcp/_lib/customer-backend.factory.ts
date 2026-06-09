// src/lib/mcp/_lib/customer-backend.factory.ts — CustomerBackend selection via CUSTOMER_BACKEND env var.
//
// Mirrors catalog-backend.factory.ts exactly:
//   - Reads process.env.CUSTOMER_BACKEND at CALL TIME (not module-load) so tests and
//     feature flags can toggle without a module reload.
//   - Default is "velora" when unset / blank — safe for all existing deployments.
//   - Fail-loud on unknown values: a typo'd CUSTOMER_BACKEND must not silently fall back.
//
// Supported backends:
//   "velora"      (default) — VeloraCustomerAdapter wrapping the existing customer-queries functions.
//   "tiendanube"            — TiendanubeCustomerAdapter for a connected Tiendanube (Nuvemshop) store.
//                            delete_customer returns "has_history" when TN returns 422 (customer has orders).
//                            Credentials via BusinessChannelCredential(provider="tiendanube").
//
// Adding a new backend:
//   1. Implement `src/lib/mcp/_lib/<name>-customer.adapter.ts` satisfying CustomerBackend.
//   2. Add a branch below: case "<name>": return new YourAdapter().
//   3. Add the string to SUPPORTED_BACKENDS.

import type { CustomerBackend } from "./customer-backend.port";
import { VeloraCustomerAdapter } from "./velora-customer.adapter";
import { TiendanubeCustomerAdapter } from "./tiendanube-customer.adapter";

const SUPPORTED_BACKENDS = ["velora", "tiendanube"] as const;
type SupportedBackend = (typeof SUPPORTED_BACKENDS)[number];

/**
 * Returns a CustomerBackend instance for the active backend.
 *
 * Resolution order (first non-blank wins):
 *   1. tenantOverride  — per-tenant slug from TenantToolConfig (null = not set)
 *   2. CUSTOMER_BACKEND — global env var
 *   3. "velora"         — hard default
 *
 * Throws on any unrecognised value — fail-loud, not silent-fallback.
 * Existing no-arg callers are unaffected (tenantOverride defaults to undefined).
 */
export function createCustomerBackend(tenantOverride?: string | null): CustomerBackend {
  // Tenant override wins when present and non-blank; then env; then "velora".
  const raw = (tenantOverride ?? process.env.CUSTOMER_BACKEND ?? "").trim() || "velora";

  // Validate membership BEFORE the switch so the `never` exhaustiveness check in
  // the default branch stays meaningful (mirrors catalog-backend.factory.ts pattern).
  if (!(SUPPORTED_BACKENDS as readonly string[]).includes(raw)) {
    throw new Error(
      `Unknown CUSTOMER_BACKEND="${raw}". Supported backends: ${SUPPORTED_BACKENDS.join(", ")}.`,
    );
  }
  const backend = raw as SupportedBackend;

  switch (backend) {
    case "velora":
      return new VeloraCustomerAdapter();

    case "tiendanube":
      return new TiendanubeCustomerAdapter();

    default: {
      const _exhaustive: never = backend;
      void _exhaustive;
      throw new Error(
        `Unknown CUSTOMER_BACKEND="${backend}". Supported backends: ${SUPPORTED_BACKENDS.join(", ")}.`,
      );
    }
  }
}
