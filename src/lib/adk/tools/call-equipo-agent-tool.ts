import "server-only";
// ADK FunctionTool — call_equipo_agent
//
// Role-agent for Equipo (RH). Routes to /api/agents/equipo/jsonrpc.
// Added in Fase E. Owner-only — the agent emits create_employee /
// reset_employee_pin / get_employee_credentials / broadcast_employees as
// Pattern C structured intents that the owner-handler inlines into
// supResult.actions for the existing executors to materialize.

import { Type } from "@google/genai";
import type { Schema } from "@google/genai";
import { EQUIPO_AGENT_TIMEOUT_MS } from "@/lib/agent-timeouts";
import {
  createA2AAgentTool,
  type A2AAgentToolContext,
} from "./_shared/create-a2a-agent-tool";

export type CallEquipoAgentToolContext = A2AAgentToolContext;

const CALL_EQUIPO_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    message: {
      type: Type.STRING,
      description:
        "El mensaje a enviar al agente de Equipo. Describir la operación de RH (alta de empleado, reset PIN, ver credenciales, aviso puntual al equipo).",
    },
  },
  required: ["message"],
};

export function createCallEquipoAgentTool(ctx: CallEquipoAgentToolContext) {
  return createA2AAgentTool(
    {
      toolName: "call_equipo_agent",
      description:
        "Llamar al agente de Equipo (RH) para alta de empleados, gestión de PINs/credenciales o avisos puntuales al equipo. NO para reglas recurrentes — eso es create_business_rule.",
      schema: CALL_EQUIPO_SCHEMA,
      timeoutMs: EQUIPO_AGENT_TIMEOUT_MS,
      callerIdentity: "supervisor",
      targetIdentity: "equipo",
      agentPath: "/api/agents/equipo/jsonrpc",
      logActionKey: "EQUIPO",
      agentDisplayName: "Equipo Agent",
      includeCodeInA2AError: true,
    },
    ctx,
  );
}
