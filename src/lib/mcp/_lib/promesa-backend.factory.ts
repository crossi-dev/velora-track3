// src/lib/mcp/_lib/promesa-backend.factory.ts — PromesaBackend selection via PROMESA_BACKEND env var.
//
// Mirrors catalog-backend.factory.ts / fiscal-backend.factory.ts exactly:
//   - Reads process.env.PROMESA_BACKEND at CALL TIME (not module-load) so tests and
//     feature flags can toggle without a module reload.
//   - Default is "velora" when unset / blank — safe for all existing deployments.
//   - Fail-loud on unknown values: a typo'd PROMESA_BACKEND must not silently fall back.
//
// Supported backends:
//   "velora" (default) — VeloraPromesaAdapter wrapping the existing use-case instances.
//
// Adding a new backend:
//   1. Implement `src/lib/mcp/_lib/<name>-promesa.adapter.ts` satisfying PromesaBackend.
//   2. Add a branch below: case "<name>": return new YourAdapter().
//   3. Add the string to SUPPORTED_BACKENDS.

import type { PromesaBackend } from "./promesa-backend.port";
import { VeloraPromesaAdapter } from "./velora-promesa.adapter";

const SUPPORTED_BACKENDS = ["velora"] as const;
type SupportedBackend = (typeof SUPPORTED_BACKENDS)[number];

/**
 * Returns a PromesaBackend instance for the active backend.
 *
 * Resolution order (first non-blank wins):
 *   1. tenantOverride  — per-tenant slug from TenantToolConfig (null = not set)
 *   2. PROMESA_BACKEND — global env var
 *   3. "velora"        — hard default
 *
 * Throws on any unrecognised value — fail-loud, not silent-fallback.
 * Existing no-arg callers are unaffected (tenantOverride defaults to undefined).
 */
export function createPromesaBackend(tenantOverride?: string | null): PromesaBackend {
  // Tenant override wins when present and non-blank; then env; then "velora".
  const raw = (tenantOverride ?? process.env.PROMESA_BACKEND ?? "").trim() || "velora";

  // Validate membership BEFORE the switch so the `never` exhaustiveness check in
  // the default branch stays meaningful (mirrors catalog-backend.factory.ts pattern).
  if (!(SUPPORTED_BACKENDS as readonly string[]).includes(raw)) {
    throw new Error(
      `Unknown PROMESA_BACKEND="${raw}". Supported backends: ${SUPPORTED_BACKENDS.join(", ")}.`,
    );
  }
  const backend = raw as SupportedBackend;

  switch (backend) {
    case "velora":
      return new VeloraPromesaAdapter();

    default: {
      const _exhaustive: never = backend;
      void _exhaustive;
      throw new Error(
        `Unknown PROMESA_BACKEND="${backend}". Supported backends: ${SUPPORTED_BACKENDS.join(", ")}.`,
      );
    }
  }
}
