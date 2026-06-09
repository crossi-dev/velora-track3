// Communications RPC orchestrator — thin handler over the Communications ADK agent.
//
// Captures every tool response (Pattern C intents) and forwards them as
// dataParts so the supervisor's downstream pipeline can materialize
// send_owner_push / send_employee_push / write_owner_chat_message intents
// through the existing idempotent + audited mutation path.

import { randomUUID } from "crypto";
import { createCommunicationsAgent } from "@/lib/adk/communications-agent";
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
} from "@velora/core-utils/jsonrpc-types";

// ── Comms skill re-exports (in-process direct-import boundary) ─────────────
// Google ADK A2A 2026: in-process helpers within the same Cloud Run service
// may be called via direct import rather than HTTP. The Comms agent is the
// single source of truth for all customer-facing WPP sends; these re-exports
// form the agent's skill surface for in-process callers.
// Ref: https://google.github.io/adk-docs/agents/multi-agents/#agent-to-agent
export {
  sendCustomerTrackingWpp,
  type SendCustomerTrackingWppParams,
} from "./send-customer-tracking-wpp";
export {
  sendCustomerPaymentLink,
  type SendCustomerPaymentLinkParams,
  type SendCustomerPaymentLinkResult,
} from "./send-customer-payment-link";
export {
  sendCustomerReceipt,
  type SendCustomerReceiptParams,
} from "./send-customer-receipt";
export {
  sendCustomerRefundNotification,
  type SendCustomerRefundNotificationParams,
  type RefundNotificationReason,
} from "./send-customer-refund-notification";

export type { JsonRpcRequest, JsonRpcResponse };
export { RPC_ERRORS, rpcError };

export const COMMUNICATIONS_MAX_INPUT_CHARS = 4_000;

// ADK runner timeout — env-overridable so Cloud Run can tune without a redeploy.
// Default 20s: Communications is Flash-tier; WPP sends are typically fast.
// Outer A2A client (COMMUNICATIONS_AGENT_TIMEOUT_MS) = 32s = inner 20s + 12s margin.
// Source: Google SRE Book — Deadline Propagation (Addressing Cascading Failures)
// https://sre.google/sre-book/addressing-cascading-failures/
const COMMUNICATIONS_ADK_TIMEOUT_MS = Number(process.env.COMMUNICATIONS_ADK_TIMEOUT_MS ?? "20000");

export async function handleCommunicationsRpc(
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
      const capturedIntents: CapturedIntent[] = [];
      const businessId = ctx?.businessId ?? null;

      const agent = createCommunicationsAgent();

      const { replyText, error } = await runRpcAgent({
        agent,
        appName: "velora-communications-agent",
        userId: businessId ?? "communications-rpc-call",
        message: text,
        timeoutMs: COMMUNICATIONS_ADK_TIMEOUT_MS,
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
        const classified = handleRpcRunnerError(error, "Communications", body, contextId, businessId, COMMUNICATIONS_ADK_TIMEOUT_MS);
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
