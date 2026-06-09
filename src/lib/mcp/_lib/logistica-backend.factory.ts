// src/lib/mcp/_lib/logistica-backend.factory.ts — LogisticaBackend selection via LOGISTICA_BACKEND env var.
//
// Mirrors ventas-backend.factory.ts exactly:
//   - Reads process.env.LOGISTICA_BACKEND at CALL TIME (not module-load) so tests and
//     feature flags can toggle without a module reload.
//   - Default is "velora" when unset / blank — safe for all existing deployments.
//   - Fail-loud on unknown values: a typo'd LOGISTICA_BACKEND must not silently fall back.
//
// Supported backends:
//   "velora" (default) — VeloraLogisticaAdapter wrapping the existing courier helpers.
//
// Adding a new backend:
//   1. Implement `src/lib/mcp/_lib/<name>-logistica.adapter.ts` satisfying LogisticaBackend.
//   2. Add a branch below: case "<name>": return new YourAdapter().
//   3. Add the string to SUPPORTED_BACKENDS.

import type { LogisticaBackend } from "./logistica-backend.port";
import { VeloraLogisticaAdapter } from "./velora-logistica.adapter";

const SUPPORTED_BACKENDS = ["velora"] as const;
type SupportedBackend = (typeof SUPPORTED_BACKENDS)[number];

/**
 * Returns a LogisticaBackend instance for the active backend.
 *
 * Resolution order (first non-blank wins):
 *   1. tenantOverride   — per-tenant slug from TenantToolConfig (null = not set)
 *   2. LOGISTICA_BACKEND — global env var
 *   3. "velora"          — hard default
 *
 * Throws on any unrecognised value — fail-loud, not silent-fallback.
 * Existing no-arg callers are unaffected (tenantOverride defaults to undefined).
 */
export function createLogisticaBackend(tenantOverride?: string | null): LogisticaBackend {
  // Tenant override wins when present and non-blank; then env; then "velora".
  const raw = (tenantOverride ?? process.env.LOGISTICA_BACKEND ?? "").trim() || "velora";

  // Validate membership BEFORE the switch so the `never` exhaustiveness check in
  // the default branch stays meaningful (mirrors ventas-backend.factory.ts pattern).
  if (!(SUPPORTED_BACKENDS as readonly string[]).includes(raw)) {
    throw new Error(
      `Unknown LOGISTICA_BACKEND="${raw}". Supported backends: ${SUPPORTED_BACKENDS.join(", ")}.`,
    );
  }
  const backend = raw as SupportedBackend;

  switch (backend) {
    case "velora":
      return new VeloraLogisticaAdapter();

    default: {
      const _exhaustive: never = backend;
      void _exhaustive;
      throw new Error(
        `Unknown LOGISTICA_BACKEND="${backend}". Supported backends: ${SUPPORTED_BACKENDS.join(", ")}.`,
      );
    }
  }
}
