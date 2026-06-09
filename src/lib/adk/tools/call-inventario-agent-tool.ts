import "server-only";
// ADK FunctionTool — call_inventario_agent
//
// Role-agent for Inventario (stock + catálogo). Routes to /api/agents/inventario/jsonrpc.
// Owner-only — the agent owns physical stock levels and product catalog.
// Does NOT handle sales recording (Ventas), cash movements (Caja), payments (Payments),
// or fiscal operations (Fiscal). Reads are autonomous; mutations require HITL gate.
//
// The agent emits structured intents { intent, data, summary } (Pattern C) for mutations.
// The Supervisor's downstream pipeline materialises them through the existing idempotent
// + audited mutation path (supervisor-action-mapper.ts → owner-handler.ts).

import { Type } from "@google/genai";
import type { Schema } from "@google/genai";
import { INVENTARIO_AGENT_TIMEOUT_MS } from "@/lib/agent-timeouts";
import {
  createA2AAgentTool,
  type A2AAgentToolContext,
} from "./_shared/create-a2a-agent-tool";

export type CallInventarioAgentToolContext = A2AAgentToolContext;

const CALL_INVENTARIO_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    message: {
      type: Type.STRING,
      description:
        "El mensaje a enviar al agente de Inventario. Describir la operación de stock " +
        "o catálogo: consulta de stock, alerta de stock bajo, ajuste de inventario, " +
        "conteo físico, transferencia entre sucursales, o gestión de productos (precio, " +
        "nombre, creación, eliminación). NO incluir operaciones de venta ni movimientos de caja.",
    },
  },
  required: ["message"],
};

export function createCallInventarioAgentTool(ctx: CallInventarioAgentToolContext) {
  return createA2AAgentTool(
    {
      toolName: "call_inventario_agent",
      description:
        "Llamar al agente de Inventario para consultas de stock, alertas de stock bajo, " +
        "ajustes de inventario (carga, ajuste manual, conteo físico), transferencias entre " +
        "sucursales, y gestión del catálogo de productos (precio, nombre, creación, eliminación). " +
        "NO usar para registrar ventas (eso es call_ventas_agent) ni pagos (call_payments_agent).",
      schema: CALL_INVENTARIO_SCHEMA,
      timeoutMs: INVENTARIO_AGENT_TIMEOUT_MS,
      callerIdentity: "supervisor",
      targetIdentity: "inventario",
      agentPath: "/api/agents/inventario/jsonrpc",
      logActionKey: "INVENTARIO",
      agentDisplayName: "Inventario Agent",
      includeCodeInA2AError: true,
    },
    ctx,
  );
}
