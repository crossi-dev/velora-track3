import type { SupervisorAction } from "./business-rule-actions";

export interface BroadcastResult {
  confirmation: string | null;
  error: string | null;
  notified: number;
}

// Employee concept removed (0 rows in production, Stage 1 cleanup) — there is
// never an active-employee audience to broadcast to. Kept as a stub (rather
// than deleting the file + its caller in business-rule-actions.ts's shared
// SupervisorAction dispatcher, which still routes "broadcast_employees" intents
// here) so the Supervisor LLM's broadcast_employees intent gets a warm no-op
// reply instead of an unhandled-intent error.
export async function executeBroadcastActions(
  actions: ReadonlyArray<SupervisorAction>,
  _businessId: string,
  _actorUserId: string,
  _idempotencySeed: string,
): Promise<BroadcastResult> {
  const broadcastActions = actions.filter((a) => a.intent === "broadcast_employees");
  if (broadcastActions.length === 0) return { confirmation: null, error: null, notified: 0 };

  return { confirmation: "No hay empleados activos para notificar.", error: null, notified: 0 };
}
