// src/lib/mcp/_lib/messaging-backend.factory.ts — MessagingBackend selection via MESSAGING_BACKEND env var.
//
// Mirrors catalog-backend.factory.ts exactly:
//   - Reads process.env.MESSAGING_BACKEND at CALL TIME (not module-load) so tests and
//     feature flags can toggle without a module reload.
//   - Default is "velora" when unset / blank — safe for all existing deployments.
//   - Fail-loud on unknown values: a typo'd MESSAGING_BACKEND must not silently fall back.
//
// Supported backends:
//   "velora" (default) — VeloraMessagingAdapter wrapping the existing lib functions.
//
// Adding a new backend:
//   1. Implement `src/lib/mcp/_lib/<name>-messaging.adapter.ts` satisfying MessagingBackend.
//   2. Add a branch below: case "<name>": return new YourAdapter().
//   3. Add the string to SUPPORTED_BACKENDS.

import type { MessagingBackend } from "./messaging-backend.port";
import { VeloraMessagingAdapter } from "./velora-messaging.adapter";

const SUPPORTED_BACKENDS = ["velora"] as const;
type SupportedBackend = (typeof SUPPORTED_BACKENDS)[number];

/**
 * Returns a MessagingBackend instance for the active backend.
 *
 * Resolution order (first non-blank wins):
 *   1. tenantOverride   — per-tenant slug from TenantToolConfig (null = not set)
 *   2. MESSAGING_BACKEND — global env var
 *   3. "velora"          — hard default
 *
 * Throws on any unrecognised value — fail-loud, not silent-fallback.
 * Existing no-arg callers are unaffected (tenantOverride defaults to undefined).
 */
export function createMessagingBackend(tenantOverride?: string | null): MessagingBackend {
  // Tenant override wins when present and non-blank; then env; then "velora".
  const raw = (tenantOverride ?? process.env.MESSAGING_BACKEND ?? "").trim() || "velora";

  // Validate membership BEFORE the switch so the `never` exhaustiveness check in
  // the default branch stays meaningful (mirrors catalog-backend.factory.ts pattern).
  if (!(SUPPORTED_BACKENDS as readonly string[]).includes(raw)) {
    throw new Error(
      `Unknown MESSAGING_BACKEND="${raw}". Supported backends: ${SUPPORTED_BACKENDS.join(", ")}.`,
    );
  }
  const backend = raw as SupportedBackend;

  switch (backend) {
    case "velora":
      return new VeloraMessagingAdapter();

    default: {
      const _exhaustive: never = backend;
      void _exhaustive;
      throw new Error(
        `Unknown MESSAGING_BACKEND="${backend}". Supported backends: ${SUPPORTED_BACKENDS.join(", ")}.`,
      );
    }
  }
}
