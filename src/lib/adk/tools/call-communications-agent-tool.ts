import "server-only";
// ADK FunctionTool — call_communications_agent
//
// Routes to /api/agents/communications/jsonrpc — the dedicated Communications
// Agent added 2026-05-25.
// Pattern C: the agent emits structured intents in dataParts which the
// owner-handler inlines into supResult.actions for the existing pipeline.
//
// Scope: Web Push (VAPID/FCM), in-app ChatMessage writes.
// Out of scope: WhatsApp (thin lib, not a peer agent).

import { Type } from "@google/genai";
import type { Schema } from "@google/genai";
import { COMMUNICATIONS_AGENT_TIMEOUT_MS } from "@/lib/agent-timeouts";
import {
  createA2AAgentTool,
  type A2AAgentToolContext,
} from "./_shared/create-a2a-agent-tool";

export type CallCommunicationsAgentToolContext = A2AAgentToolContext;

const CALL_COMMUNICATIONS_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    message: {
      type: Type.STRING,
      description:
        "El mensaje a enviar al Communications Agent. Describir la notificación a enviar: canal (push owner / push empleado / chat owner), destinatario, título, cuerpo. Incluir deepLink solo si el context lo indica.",
    },
  },
  required: ["message"],
};

export function createCallCommunicationsAgentTool(
  ctx: CallCommunicationsAgentToolContext,
) {
  return createA2AAgentTool(
    {
      toolName: "call_communications_agent",
      // Source: Wiesinger et al. §3.2 "description functions as LLM documentation — precision matters"
      // https://www.kaggle.com/whitepaper-agents
      description:
        "Sends Web Push notifications via VAPID/FCM to the owner or a specific employee, and writes in-app chat messages to the owner's chat history. " +
        "Use for any push alert or in-app notification: notificación push, aviso al dueño, mensaje interno. " +
        "NOT for WhatsApp — that channel is handled by the WhatsApp lib independently.",
      schema: CALL_COMMUNICATIONS_SCHEMA,
      timeoutMs: COMMUNICATIONS_AGENT_TIMEOUT_MS,
      callerIdentity: "supervisor",
      targetIdentity: "communications",
      agentPath: "/api/agents/communications/jsonrpc",
      logActionKey: "COMMUNICATIONS",
      agentDisplayName: "Communications Agent",
      has429Handling: true,
      rateLimitMessage:
        "Demasiadas solicitudes al Communications Agent. Esperá un momento.",
    },
    ctx,
  );
}
