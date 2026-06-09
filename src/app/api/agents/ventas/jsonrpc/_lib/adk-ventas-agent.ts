// ADK Ventas Agent — stateless per-request Agent emitting structured intents
// (Pattern C). Tools never mutate state; they return { intent, data, summary }
// which the RPC handler captures and forwards as dataParts. The downstream
// pipeline materializes the intents through the existing idempotent +
// audited mutation path.
//
// Rebuilt on agent-factory.ts (2026-05-25) — eliminates raw `new Agent()` call
// and enforces the instruction-as-callback rule project-wide.

import type { Agent } from "@google/adk";
import { createAdkAgent } from "@/lib/adk/agent-factory";
import { getAdkVentasModel } from "@/lib/adk/gemini-config";
import { VENTAS_SYSTEM_PROMPT } from "./ventas-agent-helpers";
import { buildVentasTools } from "./ventas-agent-tools";
// ventas-core-tools.ts (+ .backend.ts, .schemas.ts) are S1-DORMANT — not registered.
// Deferred to S2: by-id void handler in undo-dispatcher, DB-locked refund amounts,
// recordCriticalWriteEvent on anular_venta + devolucion_parcial (jd CRITICAL-3/4/5).

// Stateless per-request Agent factory.
// `actorUserId`: the owner's userId (audit trail when intents materialize).
// `turnId`: per-request UUID that scopes idempotency keys downstream.
export function createVentasAgent(ctx: {
  businessId: string | null;
  actorUserId: string | null;
  turnId: string;
}): Agent {
  // ctx kept stable for future tools that need businessId/actorUserId/turnId
  // (e.g. catalog snapshot enrichment in a later iteration).
  void ctx;
  return createAdkAgent({
    name: "velora_ventas_agent",
    model: getAdkVentasModel(),
    instruction: VENTAS_SYSTEM_PROMPT,
    tools: buildVentasTools(),
  });
}
