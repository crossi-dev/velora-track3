/**
 * Compound-action dedup guard.
 *
 * Deduplicates exact-duplicate supervisor actions BEFORE they reach the
 * mapper. Protects against Supervisor mis-routing where both Ventas and Caja
 * (or Ventas and Inventario) emit the same operational intent for the same
 * operation in one turn.
 *
 * CORRECTNESS: dedup is by intent + stable-serialized data, NOT intent alone.
 * Two stock_load or register_movement actions with different payloads (different
 * product, quantity, or amount) are legitimate and must BOTH survive.
 */
import { cloudLog } from "@/lib/cloud-logger";

type SupervisorAction = { intent: string; data: unknown; summary: string };

/**
 * Stable deterministic serialization of an unknown value.
 * Object keys are sorted so {b:1,a:2} and {a:2,b:1} produce the same string.
 *
 * Mirrors the client-side `stableSerialize` in utils.mutation.ts so server
 * signatures are byte-identical with the client's idempotency key scheme.
 * Server-side copy avoids importing a "use client" module.
 */
function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableSerialize(v)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableSerialize(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Dedup exact-duplicate supervisor actions before compound-action mapping.
 * Keeps the first occurrence; drops later exact-duplicates with a WARNING log
 * (observable in Cloud Logging via action: COMPOUND_ACTION_DEDUP).
 */
export function dedupSupervisorActions(
  actions: Array<SupervisorAction>,
): Array<SupervisorAction> {
  const seen = new Set<string>();
  const out: Array<SupervisorAction> = [];
  for (const action of actions) {
    const sig = `${action.intent}:${stableSerialize(action.data)}`;
    if (seen.has(sig)) {
      cloudLog({
        severity: "WARNING",
        component: "Supervisor",
        action: "COMPOUND_ACTION_DEDUP",
        a2a_transfer: false,
        message: `Dropped exact-duplicate supervisor action (mis-routing guard): ${action.intent}`,
        data: { intent: action.intent, sig },
      });
      continue;
    }
    seen.add(sig);
    out.push(action);
  }
  return out;
}
