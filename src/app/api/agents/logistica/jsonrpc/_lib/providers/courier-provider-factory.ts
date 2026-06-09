// Courier provider factory — tenant-scoped DI.
//
// Reads Business.courierPreference (String? in schema) and returns the matching
// ProviderAdapter. Falls back to AndreaniAdapter when the preference is absent,
// invalid, or the referenced courier is not fully implemented yet.
//
// ADK 2026 pattern: the factory is a thin selector. It does NOT orchestrate API
// calls — each adapter is self-contained and owns its own circuit breaker. The
// factory only resolves WHICH adapter to hand to the tool at call time.
//
// Supported values for Business.courierPreference:
//   "andreani" — (default) AndreaniAdapter
//   "oca"      — OcaAdapter (opossum CB at oca-circuit.ts)
//   null / ""  — falls through to AndreaniAdapter
//
// LOGISTICA_PROVIDER_SELECTED is emitted on every factory call for structured
// debugging in Cloud Logging.

import { prisma } from "@/lib/prisma";
import { cloudLog } from "@/lib/cloud-logger";
import { AndreaniAdapter } from "./andreani-adapter";
import { OcaAdapter } from "./oca-adapter";
import type { ProviderAdapter } from "../logistica-provider";

// ── Supported courier slugs ───────────────────────────────────────────────────

const SUPPORTED_COURIERS = ["andreani", "oca"] as const;
type SupportedCourier = (typeof SUPPORTED_COURIERS)[number];

function isSupportedCourier(v: string): v is SupportedCourier {
  return (SUPPORTED_COURIERS as readonly string[]).includes(v.toLowerCase());
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Returns the ProviderAdapter for the tenant's preferred courier.
 *
 * Safe to call on every tool execution — the DB read is a single indexed lookup
 * on Business.id (primary key) and the result is a lightweight adapter instance.
 *
 * @param businessId  Trusted business ID from the tool closure (never from LLM).
 * @returns           The adapter for the tenant's preferred courier, or Andreani
 *                    as the safe default when the preference is unset/invalid.
 */
export async function getCourierProvider(businessId: string): Promise<ProviderAdapter> {
  let raw: string | null = null;

  try {
    const biz = await prisma.business.findUnique({
      where: { id: businessId },
      select: { courierPreference: true },
    });
    raw = biz?.courierPreference ?? null;
  } catch (err) {
    // DB read failure → safe default (Andreani). Log and continue.
    cloudLog({
      severity: "WARNING",
      component: "A2A",
      action: "LOGISTICA_PROVIDER_FACTORY_DB_ERROR",
      a2a_transfer: false,
      message: `getCourierProvider: DB read failed for businessId=${businessId} — falling back to andreani`,
      data: { businessId, error: err instanceof Error ? err.message : String(err) },
    });
  }

  // Normalise: lowercase, strip whitespace.
  const preference = raw?.trim().toLowerCase() ?? "";
  const selected: SupportedCourier =
    preference && isSupportedCourier(preference) ? preference : "andreani";

  cloudLog({
    severity: "INFO",
    component: "A2A",
    action: "LOGISTICA_PROVIDER_SELECTED",
    a2a_transfer: false,
    message: `getCourierProvider: selected=${selected} (raw preference="${raw ?? "null"}")`,
    data: { businessId, selected, rawPreference: raw ?? null },
  });

  switch (selected) {
    case "oca":
      return new OcaAdapter();
    case "andreani":
    default:
      return new AndreaniAdapter();
  }
}
