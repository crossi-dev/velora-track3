// handle-caja-rpc.ts — A2A v0.3.0 JSON-RPC dispatcher for the Caja role-agent.
//
// Single dispatch path (method "message/send"):
//   ADK agent path — params.message is an A2A spec-compliant envelope
//   ({ kind:"message", parts:[{kind:"text", text:"..."}] }).
//   Runs the ADK Caja Agent via runRpcAgent (InMemoryRunner lifecycle).
//
// Cash-drawer agent: opens/closes shifts, queries balance, registers movements.
// This agent has NO skill-dispatch path — all interactions are conversational.
//
// Source (timeout hierarchy): https://sre.google/sre-book/addressing-cascading-failures/
// Inner CAJA_ADK_TIMEOUT_MS = 25s. Outer CAJA_AGENT_TIMEOUT_MS = 32s (+7s margin).

import { randomUUID } from "crypto";
import { cloudLog } from "@/lib/cloud-logger";
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
import { createCajaAgent } from "./adk-caja-agent";
import type { A2APart } from "@velora/core-utils/jsonrpc-types";

// Re-export types that route.ts expects.
export type { JsonRpcRequest } from "@velora/core-utils/jsonrpc-types";
export { RPC_ERRORS, rpcError };

// ADK runner timeout — env-overridable (default 25s: caja ops are DB-only, fast).
// Outer A2A client CAJA_AGENT_TIMEOUT_MS = 32s = 25s + 7s margin.
// Source: https://sre.google/sre-book/addressing-cascading-failures/
const CAJA_ADK_TIMEOUT_MS = Number(process.env.CAJA_ADK_TIMEOUT_MS ?? "25000");

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractParams(params: unknown): Record<string, unknown> {
  if (params && typeof params === "object" && !Array.isArray(params)) {
    return params as Record<string, unknown>;
  }
  return {};
}

// ── Main dispatcher ───────────────────────────────────────────────────────────

export async function handleCajaRpc(
  body: JsonRpcRequest,
  ctx?: { businessId?: string | null },
) {
  if (!body || body.jsonrpc !== "2.0" || typeof body.method !== "string") {
    return rpcError(body?.id, RPC_ERRORS.INVALID_REQUEST);
  }

  switch (body.method) {
    case "message/send": {
      const params = extractParams(body.params);
      const hasTextMessage = extractTextFromParams(body.params) !== null;

      if (!hasTextMessage) {
        return rpcError(
          body.id,
          RPC_ERRORS.INVALID_PARAMS,
          "message.parts must contain at least one text part",
        );
      }

      // Caja has only the ADK free-text path — no skill-dispatch.
      return handleAdkAgentDispatch(body, ctx);
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

  if (!trustedBusinessId) {
    cloudLog({
      severity: "ERROR",
      component: "A2A",
      action: "CAJA_AGENT_MISSING_BUSINESS_ID",
      a2a_transfer: false,
      message: "ADK Caja dispatch received no businessId in ctx — rejecting request",
      data: { contextId },
    });
    return rpcError(body.id, RPC_ERRORS.INVALID_PARAMS, "businessId is required");
  }

  // The Caja agent needs a backend context for the tool closures.
  // actorUserId + actorEmployeeId are set to synthetic sentinel values here;
  // for the full owner-path turn, the Supervisor passes businessId only — the
  // agent itself doesn't need the actor for reads. For mutations (open/close/
  // movement), the tools accept actorUserId and actorEmployeeId via the backend.
  // The canonical A2A caller (Supervisor) is identified by its signed JWT; the
  // businessId from the JWT is the authoritative tenant scope.
  // Limitation: actorEmployeeId is null on A2A path (employee identity is the
  // Supervisor's JWT, not an employee session). Recorded in recordCriticalWriteEvent
  // as actorUserId="supervisor-a2a", actorEmployeeId=null. Acceptable for now
  // (documented gap — production enforcement is via the per-tenant HMAC key gate).
  //
  // Part A (feat/caja-pilot-harden-modularize): turnId = contextId.
  // contextId is extracted from the A2A message params (caller-supplied stable ID) or
  // generated once as randomUUID() above. The SAME contextId is reused for all tool
  // calls within this RPC dispatch, making it stable across Cloud Run retries of the
  // same JSON-RPC request. A new contextId per request means distinct tools calls in
  // different requests get different keys — cross-request replay is impossible.
  // The tools derive idempotency keys via deriveServerKey(turnId, toolName, input).
  const backend = {
    businessId: trustedBusinessId,
    actorUserId: "supervisor-a2a",
    actorEmployeeId: null,
    turnId: contextId,
  };

  const agent = createCajaAgent(backend);

  // jd/caja-agent W-3: track whether any caja tool actually executed, so a reply
  // that CLAIMS a cash state-change without a real DB write can be blocked.
  let cajaToolCalled = false;
  const { replyText, error } = await runRpcAgent({
    agent,
    appName: "velora-caja-agent",
    userId: "caja-rpc-call",
    message: text,
    timeoutMs: CAJA_ADK_TIMEOUT_MS,
    onFunctionResponse: () => {
      cajaToolCalled = true;
    },
  });

  if (error !== null) {
    const classified = handleRpcRunnerError(
      error,
      "Caja",
      body,
      contextId,
      trustedBusinessId,
      CAJA_ADK_TIMEOUT_MS,
    );
    if (classified.earlyResponse !== null) return classified.earlyResponse;
    const parts: A2APart[] = [{ kind: "text", text: classified.replyText }];
    return rpcResult(body.id, {
      kind: "message",
      messageId: randomUUID(),
      role: "agent",
      parts,
      contextId,
    });
  }

  // jd/caja-agent W-3: no-tool-call hallucination guard. If the reply asserts a
  // cash state-change but no caja tool executed, the DB was never written — block it.
  const claimsStateChange =
    /caja\s+(cerrada|abierta)|movimiento\s+registrad|turno\s+(abierto|cerrado)|arqueo\s+(completado|realizado|registrado|cerrado)/i.test(replyText);
  if (claimsStateChange && !cajaToolCalled) {
    cloudLog({
      severity: "ERROR",
      component: "System",
      action: "CAJA_NO_TOOL_HALLUCINATION",
      a2a_transfer: false,
      message: "Caja agent claimed a cash state-change with no tool call — blocking (no DB write happened).",
      businessId: trustedBusinessId,
      data: { replyPreview: replyText.slice(0, 120) },
    });
    const blockParts: A2APart[] = [
      { kind: "text", text: "No pude completar la operación de caja en este momento. Probá de nuevo." },
    ];
    return rpcResult(body.id, {
      kind: "message",
      messageId: randomUUID(),
      role: "agent",
      parts: blockParts,
      contextId,
    });
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
