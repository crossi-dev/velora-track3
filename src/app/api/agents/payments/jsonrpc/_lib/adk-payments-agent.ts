// ADK Payments Agent setup — rebuilt on agent-factory.ts (2026-05-25).
// Eliminates raw `new Agent()` call and enforces the instruction-as-callback
// rule project-wide (avoids ADK "Context variable not found" on JSON braces).
// Payment-provider I/O is delegated via PaymentProviderAdapter — no direct MP imports here.
// Tool factories live in payments-agent-tools.ts.
//
// Strangler-fig convergence (feat/converge-payments-flagged, 2026-06-03):
//   USE_MCP_PAYMENTS_TOOL=false (default) → old buildCreatePaymentLinkTool (FunctionTool, unchanged).
//   USE_MCP_PAYMENTS_TOOL=true           → buildMcpCreatePaymentLinkTool (same name + schema,
//                                          delegates to executeCrearLinkPago shared execute body).
// Both branches expose tool name "create_payment_link" to the LLM — agent behaviour is unchanged.
// Flag is read at call time (not module load) — toggle takes effect without a server restart.
// Sources: martinfowler.com/bliki/StranglerFigApplication.html
//          martinfowler.com/articles/feature-toggles.html

import { createHash, randomUUID } from "crypto";
import type { Agent } from "@google/adk";
import { createAdkAgent } from "@/lib/adk/agent-factory";
import { getAdkPaymentsModel } from "@/lib/adk/gemini-config";
import { PAYMENTS_SYSTEM_PROMPT } from "./payments-agent-helpers";
import { buildCreatePaymentLinkTool, buildGetPaymentStatusTool } from "./payments-agent-tools";
import { buildMcpCreatePaymentLinkTool, isMcpPaymentsToolEnabled } from "./payments-mcp-link-tool";
import type { BizSnapshot } from "./payments-agent-types";

// Derives a stable idempotency key per (business, description, turn).
// Amount excluded: freight can fluctuate between retries of the same turn.
// Description canonicalized (lowercase + collapsed whitespace) so LLM casing
// variance ("Venta Velora" vs "venta velora") maps to the same key.
export function buildLinkIdempotencyKey(businessId: string, description: string, turnId: string): string {
  const canonical = description.toLowerCase().trim().replace(/\s+/g, " ");
  const raw = [businessId, canonical, turnId].join("|");
  return createHash("sha256").update(raw).digest("hex").slice(0, 32);
}

// Stateless per-request Agent factory.
// `actorUserId`: the owner's userId (needed for audit trail on PaymentIntent creation).
// `turnId`: per-request UUID that scopes idempotency keys within this agent call.
// `bizSnapshot`: optional prefetched business data — when present, tools skip their
//   own business.findUnique calls, saving 2 DB roundtrips per payment tool invocation.
export function createPaymentsAgent(ctx: {
  businessId: string | null;
  actorUserId: string | null;
  turnId?: string;
  bizSnapshot?: BizSnapshot | null;
}): Agent {
  const resolvedCtx = {
    businessId: ctx.businessId,
    actorUserId: ctx.actorUserId,
    // Default to a fresh UUID if caller does not supply a turnId. Callers
    // SHOULD pass a stable turnId per request so retries are idempotent.
    turnId: ctx.turnId ?? randomUUID(),
    bizSnapshot: ctx.bizSnapshot ?? null,
  };
  return createAdkAgent({
    name: "velora_payments_agent",
    model: getAdkPaymentsModel(),
    instruction: PAYMENTS_SYSTEM_PROMPT,
    tools: [
      // Strangler-fig: flag OFF (default) → old FunctionTool; flag ON → shared execute body.
      // Both expose name "create_payment_link" — LLM routing is unchanged.
      isMcpPaymentsToolEnabled()
        ? buildMcpCreatePaymentLinkTool(resolvedCtx)
        : buildCreatePaymentLinkTool(resolvedCtx),
      buildGetPaymentStatusTool(resolvedCtx),
    ],
    // Function calling: rely on AUTO mode (the ADK default) plus the system
    // prompt's one-shot examples to guide the model to the correct tool.
    // History (2026-05):
    //   - mode: "ANY" was tried to force a tool call but caused infinite
    //     function_call retries because ADK spreads generateContentConfig
    //     into every runOneStepAsync via basic_llm_request_processor — call 2
    //     was forced into another function call. See discuss.ai.google.dev
    //     "Infinite tool call loop when setting function_calling_config to ANY".
    //   - maxLlmCalls=2 was added as a guard but turned out to be too low for
    //     Gemini 2.5 Pro + thinking (thinking pass counts as an LLM call).
    //     The cap now lives in handle-payments-rpc.ts (10) — see the comment
    //     there. AUTO + prompt discipline + 10-call cap is the
    //     2026-recommended pattern.
  });
}
