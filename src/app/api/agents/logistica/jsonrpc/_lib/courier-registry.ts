// Shared courier registry for the Logística role-agent.
// Both compare_rates and create_shipment import from here so the set of
// known couriers is declared exactly once.
//
// To disable a courier temporarily set `active: false` without deleting the
// entry. The resolveActiveCouriers helper in rate-comparison-tool.ts handles
// the per-business DB filter on top of this static list.
//
// ENCAJONADO 2026-05-25 — set active:true to re-enable. UI surface lives elsewhere.
// OCA 2026-05-26 — activated (active:true). Tenant selection via Business.courierPreference.
// The OcaAdapter handles missing credentials gracefully (empty options for quote,
// structured error for create/track) so activating it platform-wide is safe.
// Correo create/track are not supported by the MiCorreo v1 API; stays encajonado.

import { AndreaniAdapter } from "./providers/andreani-adapter";
import { OcaAdapter } from "./providers/oca-adapter";
import { CorreoAdapter } from "./providers/correo-adapter";
import { PedidosYaAdapter } from "./providers/pedidosya-adapter";
import type { ProviderAdapter } from "./logistica-provider";

export interface CourierEntry {
  name: string;
  /** When false, this courier is parked (encajonado): code stays but it is
   *  excluded from tool schemas, rate fan-outs, and dispatch fallbacks.
   *  Flip to true to re-enable without any other code change. */
  active: boolean;
  getAdapter: () => ProviderAdapter;
}

/**
 * All couriers known to the Logística layer.
 * Order matters for display (cheapest is sorted at runtime, but ties resolve
 * in this order).
 */
export const COURIER_REGISTRY: CourierEntry[] = [
  { name: "andreani",  active: true,  getAdapter: () => new AndreaniAdapter()  },
  { name: "oca",       active: true,  getAdapter: () => new OcaAdapter()       },
  { name: "correo",    active: false, getAdapter: () => new CorreoAdapter()    },
  // PedidosYa: same-city last-mile (express/scheduled). BYOA — per-business token
  // in BusinessChannelCredential(provider:"pedidosya"). active:true, but gated in
  // resolveActiveCouriers: it only participates for businesses that have actually
  // connected a PedidosYa account (so it is NOT added to everyone's quote fan-out).
  // API source: https://developers.pedidosya.com/courier-api/v3.json (v3, verified 2026-06-04).
  { name: "pedidosya", active: true, getAdapter: () => new PedidosYaAdapter() },
];

/** Returns only the couriers that are currently active (not encajonados). */
export function getActiveCourierNames(): string[] {
  return COURIER_REGISTRY.filter((c) => c.active).map((c) => c.name);
}

/**
 * Lookup a courier entry by its slug. Returns undefined if not found.
 *
 * INTENTIONAL: searches the full registry including inactive (encajonado) entries.
 * This allows track_shipment to resolve historical shipments created before a courier
 * was encajonado, and provides a consistent lookup primitive for all callers.
 *
 * Active-gate responsibility lives in CALLERS:
 *  - skill-dispatch (handleSkillDispatch) rejects inactive entries with a structured RPC error.
 *  - rate-comparison-tool uses resolveActiveCouriers / getActiveCourierNames instead.
 *  - track-shipment-tool accepts inactive entries intentionally (historical tracking).
 */
export function getCourierEntry(provider: string): CourierEntry | undefined {
  return COURIER_REGISTRY.find((c) => c.name === provider.toLowerCase());
}
