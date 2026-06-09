// rpc-runner-obs.ts — Shared ADK runner observability helpers for sub-agents.
//
// Single source of truth for the classify-and-log pattern used by all five
// sub-agents: Ventas, Logística, Communications, Payments, and Fiscal.
// Previously Payments and Fiscal each kept their own obs files; those are
// now deleted and their data (action-code prefixes, user-facing messages)
// lives here instead.
//
// All action codes are distinct so Cloud Monitoring / Logs Explorer can filter
// and alert on each agent + failure mode independently.

import { randomUUID } from "crypto";
import { cloudLog } from "@/lib/cloud-logger";
import { rpcResult } from "@velora/core-utils/jsonrpc-types";
import type { JsonRpcResponse, JsonRpcRequest } from "@velora/core-utils/jsonrpc-types";

export type AgentName = "Ventas" | "Logistica" | "Communications" | "Payments" | "Fiscal" | "Caja" | "Inventario";

// Per-agent action code prefixes for Cloud Monitoring.
const ACTION_PREFIXES: Record<AgentName, string> = {
  Ventas: "VENTAS_AGENT",
  Logistica: "LOGISTICA_AGENT",
  Communications: "COMMUNICATIONS_AGENT",
  Payments: "PAYMENTS_AGENT",
  Fiscal: "FISCAL_AGENT",
  Caja: "CAJA_AGENT",
  Inventario: "INVENTARIO_AGENT",
};

// Per-agent fallback user-facing messages.
const FALLBACK_MESSAGES: Record<AgentName, { timeout: string; maxLlmCalls: string; generic: string }> = {
  Ventas: {
    timeout: "El Ventas Agent tardó demasiado. Intentá de nuevo.",
    maxLlmCalls: "No se pudo procesar la operación de ventas (límite de llamadas alcanzado). Intentá de nuevo.",
    generic: "Error interno del Ventas Agent. Intentá de nuevo.",
  },
  Logistica: {
    timeout: "El Logística Agent tardó demasiado. Intentá de nuevo.",
    maxLlmCalls: "No se pudo procesar la operación de logística (límite de llamadas alcanzado). Intentá de nuevo.",
    generic: "Error interno del Logística Agent. Intentá de nuevo.",
  },
  Communications: {
    timeout: "El Communications Agent tardó demasiado. Intentá de nuevo.",
    maxLlmCalls: "No se pudo procesar la operación de comunicaciones (límite de llamadas alcanzado). Intentá de nuevo.",
    generic: "Error interno del Communications Agent. Intentá de nuevo.",
  },
  Payments: {
    timeout: "El Payments Agent tardó demasiado. Intentá de nuevo.",
    maxLlmCalls: "No se pudo procesar la operación de pago (límite de llamadas alcanzado). Intentá de nuevo.",
    generic: "Error interno del Payments Agent. Intentá de nuevo.",
  },
  Fiscal: {
    timeout: "El Fiscal Agent tardó demasiado. Intentá de nuevo.",
    maxLlmCalls: "No se pudo procesar la operación fiscal (límite de llamadas alcanzado). Intentá de nuevo.",
    generic: "Error interno del Fiscal Agent. Intentá de nuevo.",
  },
  Caja: {
    timeout: "El Caja Agent tardó demasiado. Intentá de nuevo.",
    maxLlmCalls: "No se pudo procesar la operación de caja (límite de llamadas alcanzado). Intentá de nuevo.",
    generic: "Error interno del Caja Agent. Intentá de nuevo.",
  },
  Inventario: {
    timeout: "El Inventario Agent tardó demasiado. Intentá de nuevo.",
    maxLlmCalls: "No se pudo procesar la operación de inventario (límite de llamadas alcanzado). Intentá de nuevo.",
    generic: "Error interno del Inventario Agent. Intentá de nuevo.",
  },
};

// Per-agent empty-drain action codes and messages for Cloud Monitoring.
const EMPTY_DRAIN_META: Partial<Record<AgentName, { action: string; message: string }>> = {
  Payments: {
    action: "PAYMENTS_AGENT_EMPTY_DRAIN",
    message: "Payments Agent drain completed with no replyText and no capturedPaymentIntentId",
  },
  Fiscal: {
    action: "FISCAL_AGENT_EMPTY_DRAIN",
    message: "Fiscal Agent drain completed with no replyText and no captured emit_invoice result",
  },
};

/**
 * Log a fully silent drain (no text, no captured tool result) for agents that
 * track this condition. Only Payments and Fiscal currently use this hook.
 *
 * Reference: same ADK drain pattern as payments-runner-obs.ts / fiscal-runner-obs.ts.
 */
export function logRpcAgentEmptyDrain(
  agentName: AgentName,
  businessId: string | null,
  contextId: string,
): void {
  const meta = EMPTY_DRAIN_META[agentName];
  if (!meta) return;
  cloudLog({
    severity: "WARNING",
    component: "A2A",
    action: meta.action,
    a2a_transfer: false,
    message: meta.message,
    businessId: businessId ?? undefined,
    data: { contextId },
  });
}

/**
 * Classify a caught error and return an early RPC response for known structured
 * failures (TimeoutError or maxLlmCalls cap). Returns null earlyResponse for
 * generic errors so the caller can fall through to its own handling.
 *
 * Reference: google.github.io/adk-docs/runtime/runconfig/ — maxLlmCalls error.
 */
export function handleRpcRunnerError(
  error: unknown,
  agentName: AgentName,
  body: JsonRpcRequest,
  contextId: string,
  businessId: string | null,
  timeoutMs: number,
): { earlyResponse: JsonRpcResponse; replyText: null } | { earlyResponse: null; replyText: string } {
  const prefix = ACTION_PREFIXES[agentName];
  const messages = FALLBACK_MESSAGES[agentName];
  const errMsg = error instanceof Error ? error.message : String(error);

  // Timeout path — distinct action code for alerting.
  if (error instanceof Error && error.name === "TimeoutError") {
    cloudLog({
      severity: "WARNING",
      component: "A2A",
      action: `${prefix}_TIMEOUT`,
      a2a_transfer: false,
      message: `${agentName} Agent ADK runner timed out after ${timeoutMs}ms`,
      businessId: businessId ?? undefined,
      data: { contextId, timeoutMs },
    });
    return {
      earlyResponse: rpcResult(body.id, {
        kind: "message",
        messageId: randomUUID(),
        role: "agent",
        parts: [{ kind: "text", text: messages.timeout }],
        contextId,
      }),
      replyText: null,
    };
  }

  // MaxLlmCalls path — ADK throws "Max number of llm calls limit of N exceeded".
  if (errMsg.includes("Max number of llm calls")) {
    const limitMatch = errMsg.match(/(\d+)/);
    cloudLog({
      severity: "WARNING",
      component: "A2A",
      action: `${prefix}_MAX_LLM_CALLS`,
      a2a_transfer: false,
      message: `${agentName} Agent exceeded maxLlmCalls cap`,
      businessId: businessId ?? undefined,
      data: { contextId, limit: limitMatch ? Number(limitMatch[1]) : null, errorMessage: errMsg },
    });
    return {
      earlyResponse: rpcResult(body.id, {
        kind: "message",
        messageId: randomUUID(),
        role: "agent",
        parts: [{ kind: "text", text: messages.maxLlmCalls }],
        contextId,
      }),
      replyText: null,
    };
  }

  // Generic error path.
  cloudLog({
    severity: "ERROR",
    component: "A2A",
    action: `${prefix}_RUNNER_ERROR`,
    a2a_transfer: false,
    message: `${agentName} Agent ADK runner threw`,
    data: {
      errorName: error instanceof Error ? error.name : "NonError",
      errorMessage: errMsg,
      stack: error instanceof Error ? (error.stack ?? null) : null,
      contextId,
    },
  });
  return { earlyResponse: null, replyText: messages.generic };
}
