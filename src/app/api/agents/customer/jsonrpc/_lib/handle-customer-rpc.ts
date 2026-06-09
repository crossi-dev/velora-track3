// handle-customer-rpc.ts — Customer Agent A2A JSON-RPC orchestrator.
//
// Mirrors the handle-payments-rpc.ts pattern exactly:
// 1. Parse + validate the incoming A2A message/send request.
// 2. Extract (businessId, customerPhone, text) from the payload.
// 3. Run the Customer Agent via runCustomerAgent().
// 4. Return an A2A-compliant message/send response.
//
// The Supervisor is the only caller (callerIdentity: ["supervisor"] in route.ts).
// Customers do NOT call this endpoint directly — they come via webhook in future.
//
// Input format: the Supervisor embeds all three fields in the message text:
//   "businessId: <id>\ncustomerPhone: <e164>\n<customer message>"
//
// A2A Protocol v1.0: https://a2a-protocol.org/latest/specification/

import { randomUUID } from "crypto";
import { cloudLog } from "@/lib/cloud-logger";
import { runCustomerAgent } from "@/lib/adk/customer-agent";
import {
  type JsonRpcRequest,
  type JsonRpcResponse,
  type A2APart,
  RPC_ERRORS,
  rpcError,
  rpcResult,
  extractTextFromParams,
  extractContextIdFromParams,
  extractBusinessIdFromText,
} from "@velora/core-utils/jsonrpc-types";

export type { JsonRpcRequest, JsonRpcResponse };
export { RPC_ERRORS, rpcError, extractTextFromParams, extractBusinessIdFromText };

/** Max text length — consistent with other A2A handlers. */
export const CUSTOMER_MAX_INPUT_CHARS = 4_000;

/**
 * Extracts the customerPhone E.164 value from the A2A text payload.
 * Pattern: "customerPhone: +5492612345678" anchored at line start.
 */
function extractCustomerPhoneFromText(text: string): string | null {
  const match = /^customerPhone:\s*(\+\d{7,15})/m.exec(text);
  return match?.[1]?.trim() ?? null;
}

/**
 * Extracts the customer message body — everything after the header lines.
 * Header lines start with known keys (businessId:, customerPhone:).
 * The message body is the remaining non-header content.
 */
function extractCustomerMessageFromText(text: string): string {
  return text
    .split("\n")
    .filter((line) => !/^(businessId|customerPhone):\s/.test(line))
    .join("\n")
    .trim();
}

export async function handleCustomerRpcAsync(
  body: JsonRpcRequest,
  ctx?: { businessId?: string | null },
): Promise<JsonRpcResponse> {
  if (!body || body.jsonrpc !== "2.0" || typeof body.method !== "string") {
    return rpcError(body?.id, RPC_ERRORS.INVALID_REQUEST);
  }

  switch (body.method) {
    case "message/send": {
      const rawTextFull = extractTextFromParams(body.params);
      if (!rawTextFull) {
        return rpcError(body.id, RPC_ERRORS.INVALID_PARAMS, "message.parts must contain at least one text part");
      }

      // Enforce input size limit — mirrors handle-supervisor-rpc.ts:52 pattern.
      // Prevents oversized payloads (100kb+) from reaching the ADK runner.
      const rawText = rawTextFull.slice(0, CUSTOMER_MAX_INPUT_CHARS);

      const businessId = ctx?.businessId ?? extractBusinessIdFromText(rawText);
      if (!businessId) {
        return rpcError(body.id, RPC_ERRORS.INVALID_PARAMS, "businessId missing from A2A payload");
      }

      const customerPhone = extractCustomerPhoneFromText(rawText);
      if (!customerPhone) {
        return rpcError(body.id, RPC_ERRORS.INVALID_PARAMS, "customerPhone (E.164) missing from A2A payload");
      }

      const customerText = extractCustomerMessageFromText(rawText);
      if (!customerText) {
        return rpcError(body.id, RPC_ERRORS.INVALID_PARAMS, "No customer message content found");
      }

      const contextId = extractContextIdFromParams(body.params) ?? randomUUID();

      cloudLog({
        severity: "INFO",
        component: "CustomerAgent",
        action: "CUSTOMER_RPC_START",
        a2a_transfer: false,
        message: `Customer Agent A2A call started`,
        data: { businessId, customerPhone, contextId },
      });

      let replyText = "";
      try {
        const result = await runCustomerAgent({ businessId, customerPhone, text: customerText });
        replyText = result.text;
      } catch (err) {
        cloudLog({
          severity: "ERROR",
          component: "CustomerAgent",
          action: "CUSTOMER_RPC_ERROR",
          a2a_transfer: false,
          message: `Customer Agent threw: ${err instanceof Error ? err.message : String(err)}`,
          data: { businessId, customerPhone, contextId },
        });
        replyText = "Error interno del Customer Agent. Intentá de nuevo.";
      }

      const parts: A2APart[] = [
        { kind: "text", text: replyText || "Sin respuesta del Customer Agent." },
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
