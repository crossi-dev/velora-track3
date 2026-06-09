// Ventas RPC orchestrator — thin handler over adk-ventas-agent.
// ADK Agent setup → adk-ventas-agent.ts
// FunctionTools   → ventas-agent-tools.ts (each tool returns a structured
//                   intent { intent, data, summary } — Pattern C).
//
// Captures every tool response and forwards them as a dataPart so that the
// supervisor's downstream pipeline (agent-call-actions.ts + supervisor-action-
// mapper.ts) can materialize the intents through the existing idempotent +
// audited mutation path.

import { randomUUID } from "crypto";
import { createVentasAgent } from "./adk-ventas-agent";
import { runRpcAgent } from "@/app/api/agents/_lib/run-rpc-agent";
import { handleRpcRunnerError } from "@/app/api/agents/_lib/rpc-runner-obs";
import {
  type JsonRpcRequest,
  type JsonRpcResponse,
  type A2APart,
  type CapturedIntent,
  RPC_ERRORS,
  rpcError,
  rpcResult,
  extractTextFromParams,
  extractContextIdFromParams,
  extractBusinessIdFromText,
} from "@velora/core-utils/jsonrpc-types";

export type { JsonRpcRequest, JsonRpcResponse };
export { RPC_ERRORS, rpcError, extractTextFromParams, extractBusinessIdFromText };

export const VENTAS_MAX_INPUT_CHARS = 4_000;

// ADK runner timeout — env-overridable so Cloud Run can tune without a redeploy.
// Default 30s: generous for catalog/sale ops + Gemini Flash round-trip.
// Outer A2A client (VENTAS_AGENT_TIMEOUT_MS) = 42s = inner 30s + 12s margin.
// Source: Google SRE Book — Deadline Propagation (Addressing Cascading Failures)
// https://sre.google/sre-book/addressing-cascading-failures/
const VENTAS_ADK_TIMEOUT_MS = Number(process.env.VENTAS_ADK_TIMEOUT_MS ?? "30000");

export async function handleVentasRpcAsync(
  body: JsonRpcRequest,
  ctx?: { businessId?: string | null },
): Promise<JsonRpcResponse> {
  if (!body || body.jsonrpc !== "2.0" || typeof body.method !== "string") {
    return rpcError(body?.id, RPC_ERRORS.INVALID_REQUEST);
  }

  switch (body.method) {
    case "message/send": {
      const text = extractTextFromParams(body.params);
      if (!text) {
        return rpcError(
          body.id,
          RPC_ERRORS.INVALID_PARAMS,
          "message.parts must contain at least one text part",
        );
      }

      const contextId = extractContextIdFromParams(body.params) ?? randomUUID();
      const turnId = randomUUID();
      const capturedIntents: CapturedIntent[] = [];

      // Audit-trail userId is resolved downstream in supervisor-action-mapper
      // when the captured intents are materialized. The Ventas Agent's tools
      // all emit Pattern C intents (no direct DB writes), so the per-request
      // DB lookup that used to live here was pure overhead — removed 2026-05-25.
      const businessId = ctx?.businessId ?? null;
      const actorUserId: string | null = null;

      const agent = createVentasAgent({ businessId, actorUserId, turnId });

      const { replyText, error } = await runRpcAgent({
        agent,
        appName: "velora-ventas-agent",
        userId: "ventas-rpc-call",
        message: text,
        timeoutMs: VENTAS_ADK_TIMEOUT_MS,
        // Capture every tool response — multi-intent turns ("subí 10% las
        // papas y bajá 5% los vinos") emit two function calls in one turn.
        onFunctionResponse: ({ response }) => {
          if (!response) return;
          const r = response;
          if (
            typeof r.intent === "string" &&
            r.data !== undefined &&
            typeof r.summary === "string"
          ) {
            capturedIntents.push({
              intent: r.intent,
              data: r.data,
              summary: r.summary,
            });
          }
        },
      });

      if (error !== null) {
        const classified = handleRpcRunnerError(error, "Ventas", body, contextId, businessId, VENTAS_ADK_TIMEOUT_MS);
        if (classified.earlyResponse !== null) return classified.earlyResponse;
        const parts: A2APart[] = [{ kind: "text", text: classified.replyText }];
        return rpcResult(body.id, { kind: "message", messageId: randomUUID(), role: "agent", parts, contextId });
      }

      const parts: A2APart[] = [
        { kind: "text", text: replyText || "Sin respuesta del modelo." },
        ...(capturedIntents.length > 0
          ? [{ kind: "data" as const, data: { intents: capturedIntents } }]
          : []),
      ];

      return rpcResult(body.id, {
        kind: "message",
        messageId: randomUUID(),
        role: "agent",
        parts,
        contextId,
      });
    }

    case "tasks/get":
    case "tasks/cancel":
      return rpcError(body.id, RPC_ERRORS.TASK_NOT_FOUND);

    default:
      return rpcError(body.id, RPC_ERRORS.METHOD_NOT_FOUND);
  }
}
