import { z } from "zod";
import { sendMessage, A2AClientError } from "@/lib/a2a-client";
import { signAgentAssertion } from "@/lib/agent-identity";
import { sendWhatsAppMessage } from "@/lib/whatsapp";
import { cloudLog } from "@/lib/cloud-logger";
import { deriveA2AKey } from "@/app/api/a2a/jsonrpc/_lib/handle-rpc";
import {
  VENTAS_AGENT_TIMEOUT_MS,
  PAYMENTS_AGENT_TIMEOUT_MS,
  CONTADOR_AGENT_TIMEOUT_MS,
  LOGISTICA_AGENT_TIMEOUT_MS,
  COMMUNICATIONS_AGENT_TIMEOUT_MS,
} from "@/lib/agent-timeouts";
import { getAgentsBaseUrl } from "@/lib/agent-base-url";

// Derive a per-tenant A2A key for the given businessId.
// Receivers validate HMAC-SHA256(A2A_SECRET, businessId) — must derive from A2A_SECRET specifically.
// Falls back to undefined in dev when A2A_SECRET is unset (receiver admits raw-secret fallback).
function deriveApiKey(businessId: string): string | undefined {
  const secret = process.env.A2A_SECRET;
  if (!secret) return undefined;
  return deriveA2AKey(secret, businessId);
}

// Resolve the base URL for sub-agent HTTP calls.
// Delegates to getAgentsBaseUrl() so AGENTS_BASE_URL can redirect to the
// separate velora-agents service (Phase A seam, feat/agents-subdomain-p1).
function getAppUrl(): string {
  return getAgentsBaseUrl();
}

type SupervisorAction = { intent: string; data: unknown };

const AgentCallDataSchema = z.object({
  message: z.string().min(1).max(4000),
  clientPhone: z.string().min(1).max(40).optional(),
});

/** Extracts the first https:// URL in a text string. Trailing punctuation that
 *  is unlikely to be part of a URL (.,;:!?)] etc.) is trimmed off the match. */
function extractUrl(text: string): string | null {
  const match = text.match(/https?:\/\/[^\s"'<>]+/);
  if (!match) return null;
  return match[0].replace(/[.,;:!?)\]]+$/, "");
}

// Intents captured by sub-agents that emit Pattern C { intent, data, summary }
// payloads via dataParts. The owner-handler injects these into supResult.actions
// before mapSupervisorActionsToCompoundActions runs, so the existing downstream
// mutation pipeline materializes them as if the supervisor had emitted them
// directly.
export interface CapturedAgentIntent {
  intent: string;
  data: unknown;
  summary: string;
}

interface AgentCallResult {
  confirmations: string[];
  errors: string[];
  capturedIntents: CapturedAgentIntent[];
}

// Maps supervisor action intents to their A2A agent endpoint name.
// Fase B strangler split call_ventas_agent (sales/catalog/cash/contactos) from
// call_payments_agent (cobros). Each agent is a specialist with its own scope —
//
// ENCAJONADO 2026-05-25: call_equipo_agent (→ equipo) fuera del map. Backend stays; el supervisor no lo invoca.
// MercadoLibre agent removed entirely 2026-05-25 per owner directive.
//
// Fix B 2026-05-28: added call_communications_agent. Previously missing — when USE_ADK=false
// the Supervisor emits call_communications_agent as a JSON action intent but this map did not
// include it, causing silent drop of communications delegations on the non-ADK path.
// Source: A2A Protocol v1.0 §4 "explicit routing is required"
// https://a2a-protocol.org/latest/specification/
const INTENT_TO_AGENT: Record<string, "fiscal" | "payments" | "ventas" | "logistica" | "communications"> = {
  call_contador_agent: "fiscal",
  call_ventas_agent: "ventas",
  call_payments_agent: "payments",
  call_logistica_agent: "logistica",
  call_communications_agent: "communications",
};

const INTENT_TO_LABEL: Record<string, string> = {
  call_contador_agent: "Contador",
  call_ventas_agent: "Ventas",
  call_payments_agent: "Pagos",
  call_logistica_agent: "Logística",
  call_communications_agent: "Communications",
};

// Per-agent outer A2A timeout map (non-ADK path).
// Uses the same canonical constants as the ADK tool call path so both paths
// share the same hierarchy. Deadline Propagation: outer > inner + margin.
// Source: https://sre.google/sre-book/addressing-cascading-failures/
const INTENT_TO_TIMEOUT_MS: Record<string, number> = {
  call_contador_agent: CONTADOR_AGENT_TIMEOUT_MS,
  call_ventas_agent: VENTAS_AGENT_TIMEOUT_MS,
  call_payments_agent: PAYMENTS_AGENT_TIMEOUT_MS,
  call_logistica_agent: LOGISTICA_AGENT_TIMEOUT_MS,
  call_communications_agent: COMMUNICATIONS_AGENT_TIMEOUT_MS,
};

export async function executeAgentCallActions(
  actions: SupervisorAction[],
  businessId: string,
): Promise<AgentCallResult> {
  const result: AgentCallResult = { confirmations: [], errors: [], capturedIntents: [] };
  const appUrl = getAppUrl();

  const calls = actions
    .filter((a) => a.intent in INTENT_TO_AGENT)
    .map(async (a) => {
      const parsed = AgentCallDataSchema.safeParse(a.data);
      if (!parsed.success) {
        cloudLog({
          severity: "WARNING",
          component: "Supervisor",
          action: "AGENT_CALL_INVALID_PAYLOAD",
          a2a_transfer: false,
          message: "agent-call action data failed schema validation",
          data: { intent: a.intent, errors: parsed.error.flatten() },
        });
        return;
      }

      const { message, clientPhone } = parsed.data;
      const targetAgent = INTENT_TO_AGENT[a.intent];
      const agentLabel = INTENT_TO_LABEL[a.intent];
      // call_payments_agent is the new owner of the WhatsApp-payment-link flow
      // (formerly call_ventas_agent in the pre-Fase-B routing). call_ventas_agent
      // now emits operational intents via dataParts (Pattern C) — captured below.
      const isPayments = a.intent === "call_payments_agent";
      const isVentas = a.intent === "call_ventas_agent";
      // Communications also emits Pattern C intents (owner push, employee push, chat write)
      // via dataParts. Mirror the Ventas re-injection so they reach executeCommunicationsActions.
      // Ref: A2A Protocol v1.0 §3 — agent capabilities must propagate through the pipeline.
      // https://a2a-protocol.org/latest/specification/
      const isCommunications = a.intent === "call_communications_agent";
      const agentUrl = `${appUrl}/api/agents/${targetAgent}/jsonrpc`;

      // Embed businessId in the message body so the sub-agent can extract it
      // via the "^businessId: <id>" header-line convention used by both the
      // fiscal and payments handlers. Both routes require the prefix so the
      // receiver can derive and validate the per-tenant key.
      const fullMessage = `businessId: ${businessId}\n${message}`;

      // Derive per-tenant key: HMAC-SHA256(A2A_SECRET, businessId).
      // Receivers validate against the derived key; undefined = dev fallback (raw-secret admitted with WARNING).
      const apiKey = deriveApiKey(businessId);

      try {
        cloudLog({
          severity: "INFO",
          component: "Supervisor",
          action: "A2A_OUTBOUND_CALL",
          a2a_transfer: true,
          message: `HTTP A2A call → ${agentUrl}`,
          data: { intent: a.intent, businessId },
        });

        const reply = await sendMessage(agentUrl, fullMessage, {
          apiKey,
          // Factory — fresh JWT per attempt to prevent JTI replay on retries.
          agentAssertionFactory: () => signAgentAssertion("supervisor", targetAgent),
          // Per-agent outer timeout — matches canonical hierarchy in agent-timeouts.ts.
          // Each value = inner ADK timeout + 12s margin (Deadline Propagation).
          timeoutMs: INTENT_TO_TIMEOUT_MS[a.intent] ?? VENTAS_AGENT_TIMEOUT_MS,
        });

        const text = reply.text;
        if (text) result.confirmations.push(text);

        // Capture Pattern C intents emitted by sub-agents (Ventas; Communications; Equipo encajonado).
        // The agent returns { intents: CapturedAgentIntent[] } in a dataPart.
        // The owner-handler inlines these into supResult.actions so the
        // existing mapper + materialization path runs unchanged.
        if (isVentas || isCommunications) {
          for (const part of reply.dataParts ?? []) {
            if (!part || typeof part !== "object") continue;
            const obj = part as { intents?: unknown };
            if (!Array.isArray(obj.intents)) continue;
            for (const raw of obj.intents) {
              if (!raw || typeof raw !== "object") continue;
              const cand = raw as { intent?: unknown; data?: unknown; summary?: unknown };
              if (
                typeof cand.intent === "string" &&
                cand.data !== undefined &&
                typeof cand.summary === "string"
              ) {
                result.capturedIntents.push({
                  intent: cand.intent,
                  data: cand.data,
                  summary: cand.summary,
                });
              }
            }
          }
        }

        // After a payments agent call, send the checkout URL via WhatsApp
        // if the action carries a client phone number.
        if (isPayments && clientPhone) {
          const url = extractUrl(text);
          if (url) {
            const waMessage = `Tu link de pago: ${url}`;
            try {
              await sendWhatsAppMessage(clientPhone, waMessage);
            } catch (waErr) {
              cloudLog({
                severity: "WARNING",
                component: "System",
                action: "PAYMENT_LINK_WA_SEND_FAILED",
                a2a_transfer: false,
                message: "Failed to send payment link via WhatsApp",
                data: { error: waErr instanceof Error ? waErr.message : String(waErr) },
              });
            }
          }
        }
      } catch (err) {
        const errMsg = err instanceof A2AClientError
          ? `${agentLabel} Agent error (code ${err.code ?? "?"}: ${err.message})`
          : err instanceof Error
            ? `${agentLabel} Agent error: ${err.message}`
            : `${agentLabel} Agent no disponible.`;
        cloudLog({
          severity: "ERROR",
          component: "Supervisor",
          action: "A2A_OUTBOUND_CALL_FAILED",
          a2a_transfer: false,
          message: errMsg,
          data: { intent: a.intent, agentUrl },
        });
        result.errors.push(`${agentLabel} Agent no disponible.`);
      }
    });

  await Promise.allSettled(calls);
  return result;
}
