// src/lib/mcp/_lib/caja-backend.factory.ts — CajaBackend selection via CAJA_BACKEND env var.
//
// Mirrors payments-backend.factory.ts exactly:
//   - Reads process.env.CAJA_BACKEND at CALL TIME (not module-load) so tests and
//     feature flags can toggle without a module reload.
//   - Default is "velora" when unset / blank — safe for all existing deployments.
//   - Fail-loud on unknown values: a typo'd CAJA_BACKEND must not silently fall back.
//
// Supported backends:
//   "velora" (default) — VeloraCajaAdapter wrapping the existing Prisma schema.
//
// Adding a new backend:
//   1. Implement `src/lib/mcp/_lib/<name>-caja.adapter.ts` satisfying CajaBackend.
//   2. Add a branch below: case "<name>": return new YourAdapter().
//   3. Add the string to SUPPORTED_BACKENDS.

import type { CajaBackend } from "./caja-backend.port";
import { VeloraCajaAdapter } from "./velora-caja.adapter";

const SUPPORTED_BACKENDS = ["velora"] as const;
type SupportedBackend = (typeof SUPPORTED_BACKENDS)[number];

/**
 * Returns a CajaBackend instance for the active backend.
 *
 * Resolution order (first non-blank wins):
 *   1. CAJA_BACKEND — global env var
 *   2. "velora"     — hard default
 *
 * Throws on any unrecognised value — fail-loud, not silent-fallback.
 */
export function createCajaBackend(): CajaBackend {
  const raw = (process.env.CAJA_BACKEND ?? "").trim() || "velora";

  // Validate membership BEFORE the switch so the `never` exhaustiveness check in
  // the default branch stays meaningful (mirrors payments-backend.factory.ts pattern).
  if (!(SUPPORTED_BACKENDS as readonly string[]).includes(raw)) {
    throw new Error(
      `Unknown CAJA_BACKEND="${raw}". Supported backends: ${SUPPORTED_BACKENDS.join(", ")}.`,
    );
  }
  const backend = raw as SupportedBackend;

  switch (backend) {
    case "velora":
      return new VeloraCajaAdapter();

    default: {
      const _exhaustive: never = backend;
      void _exhaustive;
      throw new Error(
        `Unknown CAJA_BACKEND="${backend}". Supported backends: ${SUPPORTED_BACKENDS.join(", ")}.`,
      );
    }
  }
}
