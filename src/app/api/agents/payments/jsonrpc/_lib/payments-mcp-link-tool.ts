import "server-only";
// payments-mcp-link-tool.ts — Flag-ON path for the USE_MCP_PAYMENTS_TOOL strangler-fig.
//
// Wraps executeCrearLinkPago (the shared createTool execute body) in a raw
// FunctionTool so that:
//   (a) Tool name stays "create_payment_link" — LLM routing is unchanged.
//   (b) Schema stays createPaymentLinkParams — LLM calling convention is unchanged.
//   (c) Return shape stays flat { error, currency } / success — system prompt rule-matching is unchanged.
//   (d) Idempotency key is still server-derived via buildLinkIdempotencyKey — LLM cannot influence it.
//
// This is NOT a new business-logic path. The execute body (executeCrearLinkPago) is
// verbatim from payments-agent-tools.ts — zero behaviour change. This file is only
// the thin FunctionTool adapter that normalises ToolResult envelopes back to the
// flat shape the Payments Agent system prompt expects.
//
// Strangler-fig source: https://martinfowler.com/bliki/StranglerFigApplication.html
// Feature Toggle source: https://martinfowler.com/articles/feature-toggles.html

import { FunctionTool } from "@google/adk";
import { createPaymentLinkParams } from "./payments-link-schema";
import { executeCrearLinkPago } from "./pagos-crear-link-pago.execute";
import type { PaymentToolCtx } from "./payments-agent-types";
import type { ToolResult } from "@/lib/adk/tools/_shared/create-tool";

// Normalises a ToolResult envelope to the flat shape the Payments Agent system
// prompt expects: { error?: string, message?: string, currency?: "ARS", ... }.
// When there is no error, passes through the success payload unchanged.
// When there is a { error: { code, message } } envelope (ToolResult shape),
// converts to { error: code, message, currency: "ARS" } so existing system
// prompt rules (e.g. `error "payment_links_blocked"`) keep working.
function normaliseToolResult(result: ToolResult): Record<string, unknown> {
  if (result.error !== undefined) {
    return {
      error: result.error.code,
      message: result.error.message,
      currency: "ARS",
    };
  }
  // Success path — pass through unchanged.
  return result as Record<string, unknown>;
}

// Flag is read at call time (not module load) so toggling USE_MCP_PAYMENTS_TOOL
// takes effect without a server restart. Mirrors isPaymentsOverHttpEnabled().
export function isMcpPaymentsToolEnabled(): boolean {
  return process.env.USE_MCP_PAYMENTS_TOOL === "true";
}

/**
 * Flag-ON factory: builds a FunctionTool with name "create_payment_link" that
 * delegates to executeCrearLinkPago (the shared createTool execute body).
 * The tool name and schema are identical to buildCreatePaymentLinkTool — the
 * LLM sees no difference. Only the internal wiring changes.
 */
export function buildMcpCreatePaymentLinkTool(ctx: PaymentToolCtx): FunctionTool {
  return new FunctionTool({
    name: "create_payment_link",
    description:
      "Creates a Sale + Invoice + payment link atomically, then returns a checkout URL " +
      "to share with the customer via WhatsApp. Invariant: every payment link has a Sale. " +
      "The Supervisor must resolve customerId and productId values before calling this tool.",
    parameters: createPaymentLinkParams,
    execute: async (rawInput: unknown) => {
      // Cast to the expected input shape — same as the old FunctionTool.
      const input = rawInput as Parameters<typeof executeCrearLinkPago>[0];
      const result = await executeCrearLinkPago(input, ctx);
      return normaliseToolResult(result);
    },
  });
}
