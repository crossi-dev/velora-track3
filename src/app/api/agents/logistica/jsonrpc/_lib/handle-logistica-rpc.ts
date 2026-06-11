// A2A v0.3.0 JSON-RPC dispatcher for the Logística role-agent.
//
// Two dispatch paths (both on method "message/send"):
//
//   1. ADK agent path (Supervisor → free-text natural language):
//      Detected when params.message is a spec-compliant A2A message envelope
//      ({ kind:"message", parts:[{kind:"text", text:"..."}] }). Runs the ADK
//      Logística Agent via runRpcAgent (shared InMemoryRunner lifecycle).
//
//   2. Skill-dispatch path (Payments → deterministic params):
//      Detected when params.skill is present. Fans out to the provider adapter
//      (Andreani, mock, OCA). Used by resolveShippingQuote for shipment.quote.
//      THIS PATH MUST NEVER BE REMOVED — it is the programmatic caller path.
//
// Provider is resolved from the request params (provider slug from logistica.cotizar_envio)
// or the LOGISTICA_PROVIDER env var as a fallback for legacy quote-only callers.

import { randomUUID } from "crypto";
import { cloudLog } from "@/lib/cloud-logger";
import { applySubAgentHallucinationGuard } from "@/app/api/agents/_lib/sub-agent-hallucination-guard";
import { extractTrackingMentions } from "@/app/api/agents/_lib/sub-agent-hallucination-guard.checks";
import { runRpcAgent } from "@/app/api/agents/_lib/run-rpc-agent";
import { handleRpcRunnerError } from "@/app/api/agents/_lib/rpc-runner-obs";
import {
  type JsonRpcRequest,
  RPC_ERRORS,
  rpcError,
  rpcResult,
  extractTextFromParams,
  extractContextIdFromParams,
} from "@velora/core-utils/jsonrpc-types";
import { getCourierEntry, COURIER_REGISTRY } from "./courier-registry";
import { createLogisticaAgent } from "./adk-logistica-agent";
import type { A2APart } from "@velora/core-utils/jsonrpc-types";

// Re-export types that route.ts expects.
export type {
  JsonRpcRequest,
} from "@velora/core-utils/jsonrpc-types";
export type { JsonRpcResponse } from "./logistica-provider";
export { RPC_ERRORS, rpcError };

// ADK runner timeout — env-overridable (default 35s: Andreani ~12s + Gemini).
// Outer A2A client LOGISTICA_AGENT_TIMEOUT_MS = 47s = 35s + 12s margin.
// Source: https://sre.google/sre-book/addressing-cascading-failures/
const LOGISTICA_ADK_TIMEOUT_MS = Number(process.env.LOGISTICA_ADK_TIMEOUT_MS ?? "35000");

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractParams(params: unknown): Record<string, unknown> {
  if (params && typeof params === "object" && !Array.isArray(params)) {
    return params as Record<string, unknown>;
  }
  return {};
}

function requireString(params: Record<string, unknown>, key: string): string | null {
  const v = params[key];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

// ── Main dispatcher ───────────────────────────────────────────────────────────

export async function handleLogisticaRpc(
  body: JsonRpcRequest,
  ctx?: { businessId?: string | null },
) {
  if (!body || body.jsonrpc !== "2.0" || typeof body.method !== "string") {
    return rpcError(body?.id, RPC_ERRORS.INVALID_REQUEST);
  }

  switch (body.method) {
    case "message/send": {
      const params = extractParams(body.params);
      const hasSkill = typeof params.skill === "string" && params.skill.trim();
      const hasTextMessage = extractTextFromParams(body.params) !== null;

      // Route 1 — ADK agent (free-text message envelope from Supervisor).
      if (hasTextMessage && !hasSkill) {
        return handleAdkAgentDispatch(body, ctx);
      }

      // Route 2 — Skill-dispatch (structured params from programmatic callers).
      return handleSkillDispatch(body);
    }

    case "tasks/get":
    case "tasks/cancel":
      return rpcError(body.id, RPC_ERRORS.TASK_NOT_FOUND);

    default:
      return rpcError(body.id, RPC_ERRORS.METHOD_NOT_FOUND);
  }
}

// ── ADK agent runner ──────────────────────────────────────────────────────────

async function handleAdkAgentDispatch(
  body: JsonRpcRequest,
  ctx?: { businessId?: string | null },
) {
  const text = extractTextFromParams(body.params);
  if (!text) {
    return rpcError(
      body.id,
      RPC_ERRORS.INVALID_PARAMS,
      "message.parts must contain at least one text part",
    );
  }

  const contextId = extractContextIdFromParams(body.params) ?? randomUUID();
  const trustedBusinessId = ctx?.businessId ?? "";
  const trackingSet = new Set<string>(); // ground-truth IDs for hallucination guard

  if (!trustedBusinessId) {
    cloudLog({
      severity: "ERROR",
      component: "A2A",
      action: "LOGISTICA_AGENT_MISSING_BUSINESS_ID",
      a2a_transfer: false,
      message: "ADK Logística dispatch received no businessId in ctx — rejecting request",
      data: { contextId },
    });
    return rpcError(body.id, RPC_ERRORS.INVALID_PARAMS, "businessId is required");
  }

  const agent = createLogisticaAgent(trustedBusinessId);

  const { replyText: rawReplyText, error } = await runRpcAgent({
    agent,
    appName: "velora-logistica-agent",
    userId: "logistica-rpc-call",
    message: text,
    timeoutMs: LOGISTICA_ADK_TIMEOUT_MS,
    // Capture tool results (Wiesinger §3.3 — ground truth for hallucination guard).
    onFunctionResponse: ({ name, response }) => {
      if ((name === "logistica.crear_etiqueta" || name === "logistica.rastrear_envio") && response) {
        // Structured field (dedup path) + embedded IDs in JSON-stringified text.
        for (const src of [response.trackingNumber, response.text]) {
          if (typeof src === "string" && src) {
            for (const t of extractTrackingMentions(src)) trackingSet.add(t);
          }
        }
      }
    },
  });

  if (error !== null) {
    const classified = handleRpcRunnerError(error, "Logistica", body, contextId, trustedBusinessId, LOGISTICA_ADK_TIMEOUT_MS);
    if (classified.earlyResponse !== null) return classified.earlyResponse;
    const parts: A2APart[] = [{ kind: "text", text: classified.replyText }];
    return rpcResult(body.id, { kind: "message", messageId: randomUUID(), role: "agent", parts, contextId });
  }

  // Hallucination guard — Wiesinger §3.3 + ADK tool-output validation.
  // Empty trackingSet = no tool returned IDs = guard is a no-op (no constraint).
  // SUB_AGENT_HALLUCINATION_GUARD_MODE controls enforce/warn/off (default: enforce).
  let replyText = rawReplyText;
  if (replyText) {
    const g = applySubAgentHallucinationGuard(
      replyText,
      { agent: "logistica" as const, trackingNumbers: Array.from(trackingSet), shipmentIds: [] },
      { businessId: trustedBusinessId, agentName: "LogisticaAgent" },
    );
    if (g.blocked) {
      cloudLog({
        severity: "WARNING",
        component: "A2A",
        action: "LOGISTICA_AGENT_HALLUCINATION_GUARD",
        a2a_transfer: false,
        message: `LogisticaAgent reply blocked — mode=${g.mode} reason=${g.reason}`,
        data: { businessId: trustedBusinessId, contextId, reason: g.reason, detail: g.detail },
      });
      replyText = "No pude confirmar el número de tracking — verificá en Envíos.";
    }
  }

  const parts: A2APart[] = [
    { kind: "text", text: replyText || "Sin respuesta del modelo." },
  ];

  return rpcResult(body.id, {
    kind: "message",
    messageId: randomUUID(),
    role: "agent",
    parts,
    contextId,
  });
}

// ── Skill-dispatch (programmatic / Payments path) ─────────────────────────────
// CRITICAL: This path must not be removed. resolveShippingQuote (src/lib/shipping-quote.ts)
// and the Payments Agent call this directly with structured params for shipment.quote.

async function handleSkillDispatch(body: JsonRpcRequest) {
  const params = extractParams(body.params);
  const skill = requireString(params, "skill");
  const businessId = requireString(params, "businessId");
  const contextId = (typeof params.contextId === "string" ? params.contextId : null) ?? randomUUID();

  if (!skill) return rpcError(body.id, RPC_ERRORS.INVALID_PARAMS, "params.skill is required");
  if (!businessId) return rpcError(body.id, RPC_ERRORS.INVALID_PARAMS, "params.businessId is required");
  // Underscores allowed: test fixtures and prefixed IDs use underscore separators.
  // The factory's HMAC key check is the real security gate.
  if (!/^[a-z0-9_]{20,30}$/.test(businessId)) {
    return rpcError(body.id, RPC_ERRORS.INVALID_PARAMS, "params.businessId has invalid format");
  }

  // For the programmatic skill path, resolve the provider from the request params
  // (provider slug) or fall back to the LOGISTICA_PROVIDER env var for quote-only
  // callers (e.g. Payments Agent shipment.quote that does not pick a specific courier).
  const requestedProvider =
    typeof params.provider === "string" && params.provider.trim()
      ? params.provider.trim()
      : (process.env.LOGISTICA_PROVIDER ?? "andreani");

  const courierEntry = getCourierEntry(requestedProvider)
    // Hard fallback: if the requested slug is unknown, default to the first ACTIVE entry
    // (Andreani). This prevents a 500 for legacy callers that send no provider.
    // Uses first active entry so shelved couriers are never silently selected.
    ?? COURIER_REGISTRY.find((c) => c.active);

  // No active courier found at all — structured error, never silently route.
  if (!courierEntry) {
    return rpcError(body.id, RPC_ERRORS.INVALID_PARAMS, "No active courier available");
  }

  // Skill-dispatch must not bypass encajonamiento: if the explicitly requested
  // provider exists but is inactive, reject with a structured error so callers
  // (e.g. Payments Agent) get a clear signal rather than a silent OCA/stub dispatch.
  if (!courierEntry.active) {
    return rpcError(body.id, RPC_ERRORS.INVALID_PARAMS, "Provider not active");
  }

  const providerName = courierEntry.name;
  const adapter = courierEntry.getAdapter();

  cloudLog({
    severity: "INFO",
    component: "A2A",
    action: "LOGISTICA_RPC_DISPATCH",
    a2a_transfer: true,
    message: `Logística dispatching skill=${skill} via provider=${providerName}`,
    data: { businessId, skill, contextId, provider: providerName },
  });

  try {
    switch (skill) {
      case "shipment.quote":  return adapter.quote(params, businessId);
      case "shipment.create": return adapter.create(params, businessId);
      case "shipment.track":  return adapter.track(params, businessId);
      default:
        return rpcError(body.id, RPC_ERRORS.INVALID_PARAMS, `unknown skill: ${skill}`);
    }
  } catch (err) {
    cloudLog({
      severity: "ERROR",
      component: "A2A",
      action: "LOGISTICA_RPC_DISPATCH_ERROR",
      a2a_transfer: false,
      message: `Logística skill ${skill} threw`,
      data: { skill, businessId, provider: providerName, error: err instanceof Error ? err.message : String(err) },
    });
    return rpcError(body.id, RPC_ERRORS.INTERNAL_ERROR, `skill ${skill} failed`);
  }
}
