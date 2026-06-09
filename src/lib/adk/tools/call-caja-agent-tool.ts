import "server-only";
// ADK FunctionTool — call_caja_agent
//
// Sends a free-text natural-language cash-drawer request to the Caja
// role-agent at /api/agents/caja/jsonrpc. The agent handles:
//   - Opening / closing a shift (ciclo de caja / arqueo)
//   - Querying the current cash balance
//   - Registering ad-hoc cash movements (ingreso, gasto, retiro/sangría)
//
// This is physical-cash management ONLY. Digital payments (MP links, QR,
// transfers) belong to call_payments_agent. See 7-agent tool→agent map:
// engram architecture/velora-7-agent-tool-map.
//
// HITL note: the Caja agent operates with requiresOwnerApproval=true.
// Close-shift and register-movement ops show a DRAFT and wait for "Confirmás?"
// before writing. The server-side tool already enforces this as well.
//
// Source: Square CashDrawerShift API — physical cash shift open/close/arqueo
//   https://developer.squareup.com/reference/square/objects/CashDrawerShift
// Source: Intuit HITL Principle 1 — confirmation before money mutation
//   https://www.kaggle.com/whitepaper-agents §5

import { Type } from "@google/genai";
import type { Schema } from "@google/genai";
import { CAJA_AGENT_TIMEOUT_MS } from "@/lib/agent-timeouts";
import {
  createA2AAgentTool,
  createBriefMessage,
  type A2AAgentToolContext,
} from "./_shared/create-a2a-agent-tool";

export type CallCajaAgentToolContext = A2AAgentToolContext;

const CALL_CAJA_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    message: {
      type: Type.STRING,
      description:
        "El pedido de caja en lenguaje natural. Incluí toda la información disponible. " +
        "Ejemplos: " +
        "'Abrí la caja con $5000 de fondo' | " +
        "'¿Cuánto hay en caja?' | " +
        "'Cerrar caja, conté $12500' | " +
        "'Registrá un gasto de $800 por electricidad'",
    },
  },
  required: ["message"],
};

export function createCallCajaAgentTool(ctx: CallCajaAgentToolContext) {
  return createA2AAgentTool(
    {
      toolName: "call_caja_agent",
      // Source: Wiesinger et al. §3.2 — description is LLM documentation; precision matters.
      // https://www.kaggle.com/whitepaper-agents
      description:
        "Manages the physical cash drawer: opens/closes cash shifts (arqueo), " +
        "queries the real-time cash balance from DB (never invents amounts), " +
        "and registers ad-hoc cash movements (ingreso, gasto, retiro, sangría, impuesto, sueldo). " +
        "Use for any physical-cash intent: abrir caja, cerrar caja, saldo en caja, " +
        "registrar movimiento, sangría, fondo. " +
        "NOT for digital payments — use call_payments_agent for links/QR/transfers.",
      schema: CALL_CAJA_SCHEMA,
      timeoutMs: CAJA_AGENT_TIMEOUT_MS,
      callerIdentity: "supervisor",
      targetIdentity: "caja",
      agentPath: "/api/agents/caja/jsonrpc",
      logActionKey: "CAJA",
      agentDisplayName: "Caja Agent",
      buildFullMessage: async (args, c) => {
        return createBriefMessage({
          businessId: c.businessId,
          objective: args.message,
          outputFormat:
            "Respondé con el resultado de la operación de caja: saldo, estado del turno, " +
            "o confirmación del movimiento. Sin inventar montos ni estados.",
          failureInstruction:
            "Si la operación falló (sin turno abierto, conflicto de idempotencia, " +
            "turno ya abierto), devolvé el error real. NUNCA inventes un saldo o estado de caja.",
        });
      },
    },
    ctx,
  );
}
