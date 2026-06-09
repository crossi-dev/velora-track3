import "server-only";
// ADK FunctionTool — call_ventas_agent
//
// Role-agent for Ventas (sales / catalog / stock / cash / contactos). Routes
// to /api/agents/ventas/jsonrpc — the dedicated Ventas Agent added in Fase B.
// Pattern C: the agent emits structured intents in dataParts which the
// owner-handler inlines into supResult.actions for the existing pipeline.
//
// Money rail (links/QR) lives in call_payments_agent, not here.

import { Type } from "@google/genai";
import type { Schema } from "@google/genai";
import { VENTAS_AGENT_TIMEOUT_MS } from "@/lib/agent-timeouts";
import {
  createA2AAgentTool,
  type A2AAgentToolContext,
} from "./_shared/create-a2a-agent-tool";

export type CallVentasAgentToolContext = A2AAgentToolContext;

const CALL_VENTAS_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    message: {
      type: Type.STRING,
      description:
        "El mensaje a enviar al agente de Ventas. Pasar la directiva literal del dueño (ventas, catálogo, stock, caja, clientes, proveedores).",
    },
  },
  required: ["message"],
};

export function createCallVentasAgentTool(ctx: CallVentasAgentToolContext) {
  return createA2AAgentTool(
    {
      toolName: "call_ventas_agent",
      // Source: Wiesinger et al. §3.2 "description functions as LLM documentation — precision matters"
      // https://www.kaggle.com/whitepaper-agents
      description:
        "Manages product catalog (create, edit, delete products and price updates), records sales transactions, adjusts inventory and stock movements, queries customer registry, handles cash register movements, and manages supplier records. " +
        "Decodes Rioplatense Spanish business idioms and emits structured intent actions. " +
        "NOT for payment collection links or QR — use call_payments_agent for cobros.",
      schema: CALL_VENTAS_SCHEMA,
      timeoutMs: VENTAS_AGENT_TIMEOUT_MS,
      callerIdentity: "supervisor",
      targetIdentity: "ventas",
      agentPath: "/api/agents/ventas/jsonrpc",
      logActionKey: "VENTAS",
      agentDisplayName: "Ventas Agent",
      has429Handling: true,
      rateLimitMessage:
        "Demasiadas solicitudes al Ventas Agent en poco tiempo. Esperá un momento.",
    },
    ctx,
  );
}
