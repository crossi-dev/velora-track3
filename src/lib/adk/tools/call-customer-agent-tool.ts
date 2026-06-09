import "server-only";
// ADK FunctionTool -- call_customer_agent
//
// CANONICAL ENTRY PATH: Supervisor -> Customer Agent (single-coordinator pattern).
//
// This tool is how the Supervisor (coordinator) delegates to the Customer Agent
// (sub-agent) per Google ADK 2026 canonical multi-agent architecture:
//   https://adk.dev/workflows/collaboration/
//   "a coordinator agent handles delegation of tasks to one or more subagents"
//
// Use cases:
//   - Owner asks about a specific customer conversation ("que paso con Felix?")
//   - Owner wants to send a message to a customer via the agent
//   - Owner needs to know what a customer ordered or asked
//
// Note: inbound WPP messages bypass this tool and call runCustomerAgent() directly
// from the Cloud Tasks worker (OIDC-trusted internal path). This tool handles the
// Supervisor-initiated delegation path only.
//
// Source: Wiesinger SS3.2 -- description functions as LLM documentation.
// https://www.kaggle.com/whitepaper-agents
//
// A2A assertion: supervisor -> customer (signed with Supervisor's private key).
// Source: https://a2a-protocol.org/latest/specification/ (agent assertion)

import { Type } from "@google/genai";
import type { Schema } from "@google/genai";
import {
  createA2AAgentTool,
  createBriefMessage,
  type A2AAgentToolContext,
} from "./_shared/create-a2a-agent-tool";
import { CUSTOMER_AGENT_DISPATCH_TIMEOUT_MS } from "@/lib/agent-timeouts";

export type CallCustomerAgentToolContext = A2AAgentToolContext;

type CustomerAgentArgs = { customerPhone?: string; message: string };

const CALL_CUSTOMER_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    customerPhone: {
      type: Type.STRING,
      description: "Customer phone number in E.164 format (e.g. +5492612345678). Required.",
    },
    message: {
      type: Type.STRING,
      description:
        "The message or query to relay to the Customer Agent. Describe the context fully: " +
        "what the customer asked, what the owner wants to do, or what information is needed. " +
        "Examples: 'Que productos consulto el cliente +5492612345678?', " +
        "'Responde al cliente que el pedido esta en camino'",
    },
  },
  required: ["message"],
};

// Use the canonical Customer Agent dispatch constant -- inner ADK is 90s, outer must exceed it.
// CUSTOMER_AGENT_DISPATCH_TIMEOUT_MS = 100s = 90s inner + 10s margin.
// DO NOT alias COMMUNICATIONS_AGENT_TIMEOUT_MS here -- that constant is for the
// Communications Agent (inner ADK 20s), not the Customer Agent (inner ADK 90s).
const CUSTOMER_AGENT_TOOL_TIMEOUT_MS = CUSTOMER_AGENT_DISPATCH_TIMEOUT_MS;

export function createCallCustomerAgentTool(ctx: CallCustomerAgentToolContext) {
  return createA2AAgentTool<CallCustomerAgentToolContext, CustomerAgentArgs>(
    {
      toolName: "call_customer_agent",
      // Canonical sub-agent delegation tool. Source: Wiesinger SS3.2 -- precision in
      // description drives correct tool selection. This is the Supervisor's canonical
      // entry point to the Customer Agent sub-agent (ADK 2026 single-coordinator pattern).
      // ADK source: https://adk.dev/workflows/collaboration/
      description:
        "Canonical Supervisor -> Customer Agent delegation (sub-agent). " +
        "Delegate here when the owner asks about a specific customer conversation or " +
        "wants to act on behalf of a customer: " +
        "'que paso con Felix?', 'que clientes estan en conversacion?', " +
        "'mandale un mensaje al cliente Y sobre su pedido'. " +
        "Also handles: customer lookup, catalog Q&A, shipping quotes, payment links for customers. " +
        "NOT for catalog mutations -- those go to call_ventas_agent. " +
        "NOT for owner's own sales -- those go to call_ventas_agent or call_payments_agent.",
      schema: CALL_CUSTOMER_SCHEMA,
      timeoutMs: CUSTOMER_AGENT_TOOL_TIMEOUT_MS,
      callerIdentity: "supervisor",
      targetIdentity: "customer",
      agentPath: "/api/agents/customer/jsonrpc",
      logActionKey: "CUSTOMER",
      agentDisplayName: "Customer Agent",
      has429Handling: true,
      rateLimitMessage: "Demasiadas solicitudes al Customer Agent. Espera un momento.",
      // Embed businessId + customerPhone as header lines, then wrap in structured
      // brief envelope (GAP2 fix). extraHeaders carries the phone so the Customer Agent
      // RPC handler can extract it from the header block before processing.
      buildFullMessage: (args, c) => {
        const extraHeaders: Record<string, string> = {};
        if (args.customerPhone) {
          extraHeaders["customerPhone"] = args.customerPhone;
        }
        return createBriefMessage({
          businessId: c.businessId,
          objective: args.message,
          extraHeaders,
          outputFormat:
            "Texto plano con el resultado de la consulta o accion sobre el cliente. Incluye datos reales del contexto -- sin inventar.",
          failureInstruction:
            "Si no encontras al cliente o no podes ejecutar la accion, explica el motivo real. NUNCA inventes datos del cliente.",
        });
      },
    },
    ctx,
  );
}
