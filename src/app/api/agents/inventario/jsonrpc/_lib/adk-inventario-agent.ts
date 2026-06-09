// adk-inventario-agent.ts — ADK Agent factory for the Inventario sub-agent.
//
// Pattern: stateless per-request Agent (same as Equipo/Ventas/Logística).
// Tools: stock.consultar_stock (read), catalogo.consultar_precio (read),
//        stock.gestionar_stock (HITL mutation), stock.transferir_entre_sucursales (HITL),
//        catalogo.gestionar_producto (HITL mutation).
//
// Reads are autonomous; mutations return a structured intent { intent, data, summary }
// via the standard Pattern C pipeline — the RPC handler captures and forwards them as
// dataParts so the Supervisor's downstream pipeline can materialise through the existing
// idempotent + audited mutation path (supervisor-action-mapper.ts → owner-handler.ts).
//
// Built on agent-factory.ts (same as Equipo, added 2026-05-25) to enforce the
// instruction-as-callback rule project-wide and avoid raw `new Agent()` calls.

import type { Agent } from "@google/adk";
import { createAdkAgent } from "@/lib/adk/agent-factory";
import { getAdkInventarioModel } from "@/lib/adk/gemini-config";
import { INVENTARIO_SYSTEM_PROMPT } from "./inventario-agent-helpers";
import { buildInventarioTools } from "./inventario-agent-tools";
import type { InventarioToolsBackend } from "./inventario-agent-tools";

export function createInventarioAgent(ctx: {
  businessId: string | null;
  actorUserId: string | null;
  turnId: string;
  toolsBackend: InventarioToolsBackend;
}): Agent {
  return createAdkAgent({
    name: "velora_inventario_agent",
    model: getAdkInventarioModel(),
    instruction: INVENTARIO_SYSTEM_PROMPT,
    tools: buildInventarioTools(ctx.toolsBackend),
  });
}
