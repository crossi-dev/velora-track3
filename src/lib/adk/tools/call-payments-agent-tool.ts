import "server-only";
// ADK FunctionTool -- call_payments_agent
//
// Role-agent for Pagos (Mercado Pago / alias / CBU rail). Routes to
// /api/agents/payments/jsonrpc. Split out of call_ventas_agent in Fase B so
// Ventas (operational intents) and Pagos (money rail) live in separate agents.
//
// WhatsApp dispatch: the chip in execute-payment-link-send.ts is the sole
// canonical WA send path -- it fires only after the owner taps "Enviar".
// No automatic WA send here; the previous postSuccessHook caused double-send
// when the chip was also tapped. Decision 2026-05-30.

import { Type } from "@google/genai";
import type { Schema } from "@google/genai";
import { injectResolvedAmount, type CatalogProduct } from "./resolve-ventas-amount";
import { resolveVentasShipping, hasShippingIntent } from "./resolve-ventas-shipping";
import { PAYMENTS_AGENT_TIMEOUT_MS } from "@/lib/agent-timeouts";
import {
  createA2AAgentTool,
  createBriefMessage,
  type A2AAgentToolContext,
} from "./_shared/create-a2a-agent-tool";

export interface CallPaymentsAgentToolContext extends A2AAgentToolContext {
  /** Catalog snapshot -- used to inject amountARS deterministically into the
   *  message so the Payments Agent never has to ask the owner for the total. */
  products?: ReadonlyArray<CatalogProduct>;
}

type PaymentsAgentArgs = { message: string; clientPhone?: string };

const CALL_PAYMENTS_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    message: {
      type: Type.STRING,
      description:
        "El mensaje a enviar al agente de Pagos. Describir el cobro a generar (monto, cliente, concepto) o la consulta de estado del pago.",
    },
  },
  required: ["message"],
};

export function createCallPaymentsAgentTool(ctx: CallPaymentsAgentToolContext) {
  return createA2AAgentTool<CallPaymentsAgentToolContext, PaymentsAgentArgs>(
    {
      toolName: "call_payments_agent",
      // Source: Wiesinger et al. SS3.2 "description functions as LLM documentation -- precision matters"
      // https://www.kaggle.com/whitepaper-agents
      description:
        "Creates payment links (MercadoPago Checkout, transfer requests with alias/CBU), generates dynamic QR codes for in-store payments, and queries payment status. " +
        "Use for any collection rail: cobrar, link de pago, QR, alias, transferencia. " +
        "NOT for product sales registration -- that is call_ventas_agent.",
      schema: CALL_PAYMENTS_SCHEMA,
      timeoutMs: PAYMENTS_AGENT_TIMEOUT_MS,
      callerIdentity: "supervisor",
      targetIdentity: "payments",
      agentPath: "/api/agents/payments/jsonrpc",
      logActionKey: "PAYMENTS",
      agentDisplayName: "Pagos Agent",
      has429Handling: true,
      rateLimitMessage:
        "Demasiadas solicitudes de link de pago en poco tiempo. Espera un momento y vuelve a intentarlo.",
      // Resolve catalog amount / shipping before forwarding to Payments Agent,
      // then wrap in structured brief envelope (GAP2 fix).
      buildFullMessage: async (args, c) => {
        let resolvedMessage = args.message;
        if (c.products?.length) {
          if (hasShippingIntent(args.message)) {
            const result = await resolveVentasShipping(args.message, c.businessId, c.products);
            resolvedMessage = result.message;
          } else {
            resolvedMessage = injectResolvedAmount(args.message, c.products);
          }
        }
        return createBriefMessage({
          businessId: c.businessId,
          objective: resolvedMessage,
          outputFormat:
            "Responde con el resultado de la operacion de cobro: URL del link o estado del pago. Sin inventar datos.",
          failureInstruction:
            "Si no podes generar el link o el pago fallo, devuelve el error real del proveedor. NUNCA inventes un link o un ID de pago.",
        });
      },
      // No postSuccessHook -- the "Enviar" chip (execute-payment-link-send.ts) is the
      // single canonical WhatsApp send path. Auto-sending here double-sent the link.
    },
    ctx,
  );
}
