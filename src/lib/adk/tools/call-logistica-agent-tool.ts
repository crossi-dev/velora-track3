import "server-only";
// ADK FunctionTool — call_logistica_agent
//
// Sends a free-text natural-language logistics request to the Logística
// role-agent at /api/agents/logistica/jsonrpc. The agent reasons, fans out
// courier quotes, and returns a ranked options summary.
//
// The Supervisor composes a natural-language message (e.g.
// "Cotizá envío de 3 cajas a CP 1043 desde CP 1000") — exactly the same
// pattern call_ventas_agent uses for Payments. The skill-dispatch path inside
// the Logística endpoint is still used by the Payments Agent programmatically
// (via resolveShippingQuote / sendStructured with params.skill). This tool
// takes the ADK agent path only.

import { Type } from "@google/genai";
import type { Schema } from "@google/genai";
import { prisma } from "@/lib/prisma";
import { getMissingBusinessData } from "@/app/api/business-assistant/_lib/missing-business-data";
import { LOGISTICA_AGENT_TIMEOUT_MS } from "@/lib/agent-timeouts";
import {
  createA2AAgentTool,
  type A2AAgentToolContext,
  type A2AAgentToolResult,
} from "./_shared/create-a2a-agent-tool";

export type CallLogisticaAgentToolContext = A2AAgentToolContext;

const CALL_LOGISTICA_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    message: {
      type: Type.STRING,
      description:
        "El pedido de logística en lenguaje natural. Incluí toda la información disponible: " +
        "CP de destino, cantidad de unidades, peso si se conoce, número de tracking para rastreo, " +
        "o saleId y datos del cliente para crear un envío. " +
        "Ejemplos: " +
        "'Cotizá envío de 3 cajas a CP 1043 desde CP 1000' | " +
        "'Rastreá el envío ANX-789012' | " +
        "'Creá el envío con Andreani Estándar para venta sale_abc123, cliente García, CP 1043'",
    },
  },
  required: ["message"],
};

async function logisticaPreConditionGuard(
  args: { message: string },
  ctx: CallLogisticaAgentToolContext,
): Promise<A2AAgentToolResult | null> {
  // Precondition guard: shipping requires origin postalCode.
  // Skip only for tracking-ONLY messages — a mixed message (e.g. "cotizá un envío
  // y rastreá el anterior") also has shipping intent and must still run the guard.
  const { message } = args;
  const hasTrackingIntent = /rastrear|rastreá|track/i.test(message);
  const hasShippingIntent = /cotiz|env[ií]o|despach|mandar/i.test(message);
  const isTrackingOnly = hasTrackingIntent && !hasShippingIntent;
  if (isTrackingOnly) return null;

  const businessRow = await prisma.business.findUnique({
    where: { id: ctx.businessId },
    select: { postalCode: true, paymentProvider: true, alias: true, whatsappPhone: true, cuit: true },
  });
  const missing = getMissingBusinessData({
    postalCode: businessRow?.postalCode,
    paymentProvider: businessRow?.paymentProvider,
    alias: businessRow?.alias,
    whatsappPhone: businessRow?.whatsappPhone,
    cuit: businessRow?.cuit,
  });
  if (missing.shipping.blocked) {
    return { text: null, success: false, error: missing.shipping.ownerPrompt, missingData: true };
  }
  return null;
}

export function createCallLogisticaAgentTool(ctx: CallLogisticaAgentToolContext) {
  return createA2AAgentTool(
    {
      toolName: "call_logistica_agent",
      // Source: Wiesinger et al. §3.2 "description functions as LLM documentation — precision matters"
      // https://www.kaggle.com/whitepaper-agents
      description:
        "Quotes shipping costs (Andreani, OCA, Correo Argentino), creates shipments with selected provider, returns tracking numbers and label PDFs, and retrieves delivery status by tracking code. " +
        "Use for any shipping or dispatch intent: enviar, despachar, cotizar envío, rastrear, Andreani, OCA — " +
        "even when phrased as 'cuánto sale enviar' or 'cuánto cuesta mandar' (shipping cost, not product price). " +
        "Sending to a postal code or address is ALWAYS a shipping quote, never a product price query.",
      schema: CALL_LOGISTICA_SCHEMA,
      timeoutMs: LOGISTICA_AGENT_TIMEOUT_MS,
      callerIdentity: "supervisor",
      targetIdentity: "logistica",
      agentPath: "/api/agents/logistica/jsonrpc",
      logActionKey: "LOGISTICA",
      agentDisplayName: "Logística Agent",
      includeCodeInA2AError: true,
      includeBusinessIdInFailLog: false,
      preConditionGuard: logisticaPreConditionGuard,
    },
    ctx,
  );
}
