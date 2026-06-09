import "server-only";
// caja-tools.ts — Cash-drawer tool barrel (namespace caja.*).
//
// Source: Square CashDrawerShift API (verified HTTP 200 2026-06-02)
//   https://developer.squareup.com/reference/square/objects/CashDrawerShift
//
// Tool inventory:
//   1. caja.ciclo_caja        → caja-ciclo-tool.ts
//   2. caja.consultar_saldo   → caja-saldo-tool.ts
//   3. caja.registrar_movimiento → caja-movimiento-tool.ts
//
// All mutating tools use beginIdempotentMutation + recordCriticalWriteEvent
// (same orphan-server-entry pattern as supervisor-internal tools).
// Mutation contract entries: caja.session.open, caja.session.close, caja.movement.create.

// ── Shared backend port ────────────────────────────────────────────────────────

export interface CajaToolsBackend {
  businessId: string;
  actorUserId: string;
  actorEmployeeId: string | null;
  /**
   * Stable per-request turn identifier — passed from the RPC handler (contextId).
   * The tool factory uses this to derive idempotency keys server-side via
   * deriveServerKey(turnId, toolName, input). The LLM never supplies nor influences
   * the key — cross-intent replay is structurally impossible.
   * Source: create-tool.ts turnIdempotency seam.
   */
  turnId: string;
}

// ── Tool factories ─────────────────────────────────────────────────────────────

export { createCicloCajaTool } from "./caja-ciclo-tool";
export { createConsultarSaldoTool } from "./caja-saldo-tool";
export { createRegistrarMovimientoTool } from "./caja-movimiento-tool";
