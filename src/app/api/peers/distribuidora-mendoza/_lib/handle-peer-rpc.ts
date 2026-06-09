// Distribuidora Mendoza — JSON-RPC dispatcher.
//
// Receives a parsed JSON-RPC message/send request and routes to the
// appropriate skill handler. Returns a JSON-RPC 2.0 compliant response.
//
// Supported skills:
//   wholesale.price.quote — price quote for a product + qty
//   wholesale.order.create — create a purchase order

import { handleQuote } from "./quote-skill";
import { handleOrder } from "./order-skill";
import { randomUUID } from "crypto";

// ── Types ─────────────────────────────────────────────────────────────────────

interface A2APart {
  kind: "text" | "data";
  text?: string;
  data?: unknown;
}

interface A2AMessage {
  kind: "message";
  messageId: string;
  role: "user" | "agent";
  parts: A2APart[];
  taskId?: string;
}

interface JsonRpcRequest {
  jsonrpc: string;
  id: string | number;
  method: string;
  params?: {
    message?: A2AMessage;
    skillId?: string;
    skillParams?: Record<string, unknown>;
  };
}

interface JsonRpcSuccessResponse {
  jsonrpc: "2.0";
  id: string | number;
  result: A2AMessage;
}

interface JsonRpcErrorResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  error: { code: number; message: string };
}

type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeReply(
  id: string | number,
  dataPart: unknown,
  textSummary: string,
): JsonRpcSuccessResponse {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      kind: "message",
      messageId: randomUUID(),
      role: "agent",
      parts: [
        { kind: "text", text: textSummary },
        { kind: "data", data: dataPart },
      ],
    },
  };
}

// ── Dispatcher ────────────────────────────────────────────────────────────────

export function dispatchPeerRpc(body: unknown): JsonRpcResponse {
  const req = body as Partial<JsonRpcRequest>;
  const id = req.id ?? null;

  if (!req.params) {
    return { jsonrpc: "2.0", id, error: { code: -32600, message: "params missing" } };
  }

  const skillId = req.params.skillId;
  const skillParams = req.params.skillParams ?? extractParamsFromMessage(req.params.message);

  if (!skillId) {
    return { jsonrpc: "2.0", id: id ?? 0, error: { code: -32600, message: "skillId required" } };
  }

  const rpcId = id ?? 0;

  if (skillId === "wholesale.price.quote") {
    // Normalise productName — callers may pass `productText` or `productName`
    const quoteProductName = (skillParams["productName"] as string | undefined) ?? (skillParams["productText"] as string | undefined) ?? "";
    const quoteQty = (skillParams["qty"] as number | undefined) ?? 1;
    const result = handleQuote({ productName: quoteProductName, qty: quoteQty });
    if ("error" in result) {
      return { jsonrpc: "2.0", id: rpcId, error: { code: -32602, message: result.error } };
    }
    const qty = quoteQty;
    const first = result.quotes[0];
    const text = `3 opciones para ${first.productName} × ${qty}:\n` +
      result.quotes.map((q) =>
        `  ${q.optionLabel}. ${q.title}: $${q.totalPrice.toLocaleString("es-AR")} ARS (${q.deliveryDays}d entrega) — ${q.condition}`
      ).join("\n");
    return makeReply(rpcId, result, text);
  }

  if (skillId === "wholesale.order.create") {
    // Normalise productName — callers may pass `productText` or `productName`
    const orderProductName = (skillParams["productName"] as string | undefined) ?? (skillParams["productText"] as string | undefined) ?? "";
    const orderQty = (skillParams["qty"] as number | undefined) ?? 0;
    const result = handleOrder({
      productName: orderProductName,
      qty: orderQty,
      deliveryPostalCode: skillParams["deliveryPostalCode"] as string | undefined,
      buyerCuit: skillParams["buyerCuit"] as string | undefined,
      buyerName: skillParams["buyerName"] as string | undefined,
    });
    if ("error" in result) {
      return { jsonrpc: "2.0", id: rpcId, error: { code: -32602, message: result.error } };
    }
    const text = `Orden confirmada ${result.orderId}: ${result.productName} × ${result.qty} — $${result.totalPrice.toLocaleString("es-AR")} ARS. Entrega estimada: ${result.estimatedDelivery}. ${result.trackingNote}`;
    return makeReply(rpcId, result, text);
  }

  return {
    jsonrpc: "2.0",
    id: rpcId,
    error: { code: -32601, message: `Skill not found: ${skillId}` },
  };
}

// Fallback: try to extract skill params from free-text message parts.
// This enables using sendMessage(text) as an alternative to structured params.
function extractParamsFromMessage(
  message: A2AMessage | undefined,
): Record<string, unknown> {
  if (!message) return {};
  const dataPart = message.parts?.find((p) => p.kind === "data");
  if (dataPart?.data && typeof dataPart.data === "object") {
    return dataPart.data as Record<string, unknown>;
  }
  return {};
}
