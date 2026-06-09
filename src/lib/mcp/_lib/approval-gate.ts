// approval-gate.ts — seam for the payment-wizard approval mode.
//
// Entrega 1 scope: the wizard IS the human-in-the-loop, so the approval gate is
// ALWAYS ON (owner reviews + confirms before the cobro executes). This stub is
// the seam where a future per-business "automatic vs human supervision" toggle
// plugs in (see engram decision #2082) WITHOUT touching the write tool's call
// site — the tool already calls this and branches on the result.
//
// Until that toggle ships, this returns false for every business: no
// auto-approval, gate never bypassed.

/**
 * Whether the given business has AUTOMATIC approval enabled (cobro executes
 * without an owner confirmation step). Entrega 1: always false — gate ON.
 *
 * @param _businessId - reserved for the future per-business toggle lookup.
 */
export async function isAutoApprovalEnabled(_businessId: string): Promise<boolean> {
  return false;
}
