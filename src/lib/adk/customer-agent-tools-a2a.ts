import "server-only";
// customer-agent-tools-a2a.ts — A2A-delegating tools for the Customer Agent.
//
// Split from customer-agent-tools.ts to stay under the 300-line server/lib limit.
// Contains: quote_shipping (→ Logística), create_payment_link (→ Payments),
// send_reply_via_wpp (→ Communications), and the buildCustomerAgentTools() factory.
//
// All tools follow Wiesinger §3.2 description conventions:
// https://www.kaggle.com/whitepaper-agents

import { FunctionTool } from "@google/adk";
import { Type } from "@google/genai";
import type { Schema } from "@google/genai";
import { sendMessage } from "@/lib/a2a-client";
import { signAgentAssertion } from "@/lib/agent-identity";
import { deriveA2AKey } from "@/app/api/a2a/jsonrpc/_lib/handle-rpc";
import { cloudLog } from "@/lib/cloud-logger";
import { sendWhatsAppMessage } from "@/lib/whatsapp";
import { prisma } from "@/lib/prisma";
import { COMMUNICATIONS_AGENT_TIMEOUT_MS } from "@/lib/agent-timeouts";
import {
  createLookupOrCreateCustomerTool,
  createGetCatalogTool,
  createUpdateOwnCustomerDataTool,
  type CustomerAgentToolContext,
  ESCALATE_TO_OWNER_SCHEMA,
} from "./customer-agent-tools";
import { createUpdateOrderItemTool } from "./customer-agent-tools-order";
import {
  createQuoteShippingTool,
  createPaymentLinkForCustomerTool,
} from "./customer-agent-tools-checkout";

// ── Schemas ────────────────────────────────────────────────────────────────────

const SEND_REPLY_VIA_WPP_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    text: {
      type: Type.STRING,
      description: "The reply text to send to the customer via WhatsApp.",
    },
  },
  required: ["text"],
};

// ── Tool 4: quote_shipping ─────────────────────────────────────────────────────

// ── Tool 6: send_reply_via_wpp ─────────────────────────────────────────────────

/**
 * Delegates to Communications Agent via A2A.
 * Sends a WhatsApp reply to the customer.
 */
export function createSendReplyViaWppTool(ctx: CustomerAgentToolContext) {
  const agentUrl = `${ctx.appUrl}/api/agents/communications/jsonrpc`;
  const a2aSecret = process.env.A2A_SECRET ?? "";
  const apiKey = a2aSecret ? deriveA2AKey(a2aSecret, ctx.businessId) : undefined;

  return new FunctionTool({
    name: "send_reply_via_wpp",
    description:
      "Sends a WhatsApp message to the customer via the Communications Agent. " +
      "Use to deliver responses that need to reach the customer's phone.",
    parameters: SEND_REPLY_VIA_WPP_SCHEMA,
    execute: async (args: unknown) => {
      const { text } = (args ?? {}) as { text: string };
      const fullMessage =
        `businessId: ${ctx.businessId}\n` +
        `canal: whatsapp_customer\ndestinatario: ${ctx.customerPhone}\nmensaje: ${text}`;
      try {
        await sendMessage(agentUrl, fullMessage, {
          apiKey,
          agentAssertionFactory: () => signAgentAssertion("customer", "communications"),
          timeoutMs: COMMUNICATIONS_AGENT_TIMEOUT_MS,
        });
        return { success: true };
      } catch {
        return { success: false, error: "No pude enviar el mensaje por WhatsApp." };
      }
    },
  });
}

// ── Tool 7: escalate_to_owner ──────────────────────────────────────────────────
//
// Moved here from customer-agent-tools.ts — uses WhatsApp side-effect,
// same category as A2A-delegating tools. File split keeps both files < 300 lines.

// Escalation dedup (in-memory, 30-min TTL per instance).
// Pattern: Intercom Fin AI fires one handover notification per conversation,
// not per message. Same (businessId + customerPhone + reason) within 30 min
// is suppressed to avoid WhatsApp spam on repeated escalations.
// Ref: https://www.intercom.com/help/en/articles/8205718-fin-ai-agent-handover
const DEDUP_TTL_MS = 30 * 60 * 1000;
const _escalationDedup = new Map<string, number>();
function _isDuplicateEscalation(key: string): boolean {
  const ts = _escalationDedup.get(key);
  if (ts === undefined) return false;
  if (Date.now() - ts > DEDUP_TTL_MS) { _escalationDedup.delete(key); return false; }
  return true;
}

/**
 * Signals owner about a legitimate out-of-scope customer inquiry.
 * Per soft-rejection policy: ONLY for genuine inquiries, NOT mutation attempts.
 */
export function createEscalateToOwnerFromCustomerTool(ctx: CustomerAgentToolContext) {
  return new FunctionTool({
    name: "escalate_to_owner",
    description:
      "Notifies the business owner about a customer inquiry outside the agent's scope. " +
      "Use ONLY for legitimate inquiries (bulk orders, partnerships). " +
      "DO NOT use for owner-only mutation attempts — reject those with a soft pivot.",
    parameters: ESCALATE_TO_OWNER_SCHEMA,
    execute: async (args: unknown) => {
      const { reason } = (args ?? {}) as { reason: string };
      // Sanitize before logging: strip newlines/tabs (log-injection) + cap length.
      const safeReason = String(reason ?? "").replace(/[\r\n\t]+/g, " ").slice(0, 300);
      cloudLog({
        severity: "INFO", component: "CustomerAgent", action: "CUSTOMER_ESCALATION",
        a2a_transfer: false, message: `Customer escalation: ${safeReason}`,
        data: { businessId: ctx.businessId, customerPhone: ctx.customerPhone, reason: safeReason },
      });
      const dedupKey = `${ctx.businessId}|${ctx.customerPhone}|${reason}`;
      if (!_isDuplicateEscalation(dedupKey)) {
        _escalationDedup.set(dedupKey, Date.now());
        try {
          const biz = await prisma.business.findUnique({
            where: { id: ctx.businessId }, select: { whatsappPhone: true },
          });
          const ownerPhone = biz?.whatsappPhone;
          if (ownerPhone) {
            const text =
              `📣 Consulta de cliente (${ctx.customerPhone}):\n${reason}\n\n` +
              `Respondé directo a este número o desde el chat de Velora.`;
            await sendWhatsAppMessage(ownerPhone, text);
          } else {
            // ERROR (not WARNING): owner escalation silently fails when whatsappPhone
            // is unset — the customer gets no follow-up. This is an actionable
            // misconfiguration the operator must fix.
            // Gap: no in-app fallback today. Future: push notification to owner or
            // inbox-style pending-escalations queue. Until then, log at ERROR so
            // alerting catches it, and return normally (graceful degradation).
            cloudLog({
              severity: "ERROR", component: "CustomerAgent",
              action: "CUSTOMER_ESCALATION_NO_OWNER_PHONE", a2a_transfer: false,
              message: "escalate_to_owner: business.whatsappPhone is null — owner NOT notified. " +
                       "Fix: set whatsappPhone for this business via the Settings panel.",
              data: { businessId: ctx.businessId, customerPhone: ctx.customerPhone },
            });
          }
        } catch (err) {
          cloudLog({
            severity: "WARNING", component: "CustomerAgent",
            action: "CUSTOMER_ESCALATION_WA_FAILED", a2a_transfer: false,
            message: `escalate_to_owner: WhatsApp notify failed — ${err instanceof Error ? err.message : String(err)}`,
            data: { businessId: ctx.businessId },
          });
        }
      }
      return { escalated: true, message: "Tu consulta fue enviada al equipo. Te contactamos a la brevedad." };
    },
  });
}

// ── Builder: all 7 Customer Agent tools ───────────────────────────────────────

/**
 * Build the Customer Agent tool list (6 tools — send_reply_via_wpp excluded).
 * Tools 1-3 + 7 live in customer-agent-tools.ts (DB-direct).
 * Tools 4-5 + 7 live here (A2A delegation).
 *
 * H2/H3 fix (2026-05-29): send_reply_via_wpp (Tool 6) is NOT included here.
 * PATH B (Cloud Tasks worker): the worker sends via sendCustomerAgentReply after
 * runCustomerAgent returns — the tool would double-send and confuse the LLM on
 * Communications Agent failure.
 * PATH A (Supervisor A2A): the Supervisor receives the reply text and owns WPP
 * delivery; exposing the tool here creates an unreachable dual-send path.
 * createSendReplyViaWppTool stays in this file for potential future PATH A use
 * if/when the Supervisor explicitly delegates WPP delivery to the Customer Agent.
 *
 * ADK enforces tool restriction at the agent level:
 * any tool NOT in this list is unreachable by the LLM.
 * Source: https://adk.dev/tools/limitations/
 */
export function buildCustomerAgentTools(ctx: CustomerAgentToolContext) {
  return [
    createLookupOrCreateCustomerTool(ctx),      // Tool 1
    createGetCatalogTool(ctx),                  // Tool 2
    createUpdateOwnCustomerDataTool(ctx),       // Tool 3
    createUpdateOrderItemTool(ctx),             // Tool 8 — deterministic order/cart state
    createQuoteShippingTool(ctx),               // Tool 4
    createPaymentLinkForCustomerTool(ctx),      // Tool 5
    // Tool 6 (send_reply_via_wpp) intentionally excluded — see comment above.
    createEscalateToOwnerFromCustomerTool(ctx), // Tool 7
  ];
}
