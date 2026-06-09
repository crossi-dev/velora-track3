// Equipo RPC orchestrator — thin handler over adk-equipo-agent.
// ADK Agent setup → adk-equipo-agent.ts
// FunctionTools   → equipo-agent-tools.ts (Commit 2)
//
// Captures every tool response and forwards them as a dataPart so the
// supervisor's downstream pipeline (agent-call-actions.ts +
// supervisor-action-mapper.ts) can materialize the intents through the
// existing idempotent + audited mutation path.

import { randomUUID } from "crypto";
import { InMemoryRunner, isFinalResponse, getFunctionResponses } from "@google/adk";
import { cloudLog } from "@/lib/cloud-logger";
import { prisma } from "@/lib/prisma";
import { createEquipoAgent } from "./adk-equipo-agent";
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

export const EQUIPO_MAX_INPUT_CHARS = 4_000;

// ADK runner timeout — env-overridable so Cloud Run can tune without a redeploy.
// Default 28s: Equipo ops are lightweight employee-management queries.
// Outer A2A client (EQUIPO_AGENT_TIMEOUT_MS) = 40s = inner 28s + 12s margin.
// Source: Google SRE Book — Deadline Propagation (Addressing Cascading Failures)
// https://sre.google/sre-book/addressing-cascading-failures/
const EQUIPO_ADK_TIMEOUT_MS = Number(process.env.EQUIPO_ADK_TIMEOUT_MS ?? "28000");

export async function handleEquipoRpcAsync(
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
      let replyText = "";
      const capturedIntents: CapturedIntent[] = [];

      const businessId = ctx?.businessId ?? null;
      let actorUserId: string | null = null;
      if (businessId) {
        const biz = await prisma.business.findUnique({
          where: { id: businessId },
          select: { userId: true },
        });
        actorUserId = biz?.userId ?? null;
      }

      try {
        const agent = createEquipoAgent({ businessId, actorUserId, turnId });
        const runner = new InMemoryRunner({ agent, appName: "velora-equipo-agent" });
        const events = runner.runEphemeral({
          userId: "equipo-rpc-call",
          newMessage: { role: "user", parts: [{ text }] },
        });

        let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(
            () => reject(Object.assign(new Error("ADK equipo timed out"), { name: "TimeoutError" })),
            EQUIPO_ADK_TIMEOUT_MS,
          );
        });

        const drainEvents = async () => {
          for await (const event of events) {
            const funcResponses = getFunctionResponses(event);
            for (const fr of funcResponses) {
              if (!fr.response || typeof fr.response !== "object") continue;
              const r = fr.response as Record<string, unknown>;
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
            }
            if (!isFinalResponse(event)) continue;
            for (const part of event.content?.parts ?? []) {
              if (typeof part.text === "string" && part.text.length > 0) {
                replyText = part.text;
              }
            }
          }
        };

        try {
          await Promise.race([drainEvents(), timeoutPromise]);
        } finally {
          if (timeoutHandle !== null) clearTimeout(timeoutHandle);
          try { await events.return(undefined); } catch { /* already exhausted */ }
        }
      } catch (error) {
        cloudLog({
          severity: "ERROR",
          component: "A2A",
          action: "EQUIPO_AGENT_RUNNER_ERROR",
          a2a_transfer: false,
          message: "Equipo Agent ADK runner threw",
          data: {
            errorName: error instanceof Error ? error.name : "NonError",
            errorMessage: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack ?? null : null,
            contextId,
          },
        });
        replyText = "Error interno del Equipo Agent. Intentá de nuevo.";
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
