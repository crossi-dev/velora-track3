// Payments RPC orchestrator — thin handler over mp-api-helpers + adk-payments-agent.
// MP API helpers → mp-api-helpers.ts
// ADK Agent setup → adk-payments-agent.ts

import { randomUUID } from "crypto";
import { cloudLog } from "@/lib/cloud-logger";
import { createPaymentsAgent } from "./adk-payments-agent";
import { handleRpcRunnerError, logRpcAgentEmptyDrain } from "@/app/api/agents/_lib/rpc-runner-obs";
import { extractPaymentsErrorCode } from "./payments-error-scanner";
import { applySubAgentHallucinationGuard } from "@/app/api/agents/_lib/sub-agent-hallucination-guard";
import { runRpcAgent } from "@/app/api/agents/_lib/run-rpc-agent";
import type { BizSnapshot } from "./payments-agent-types";
import { prefetchBizSnapshot, BizPrefetchHttpError } from "./payments-biz-prefetch";
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

// PAYMENTS_MAX_INPUT_CHARS kept as a named export for any external callers.
export const PAYMENTS_MAX_INPUT_CHARS = 4_000;

// ADK runner timeout — reads PAYMENTS_ADK_TIMEOUT_MS env var so Cloud Run can tune
// without a redeploy. Default 60s: Gemini Pro thinking + MP API + shipping quote
// can legitimately reach 25-30s; 60s leaves comfortable headroom.
// Cloud Run kills at 300s, so 60s still leaves 240s of cleanup headroom.
// Pattern mirrors customer-agent.ts (CUSTOMER_AGENT_ADK_TIMEOUT_MS).
const PAYMENTS_ADK_TIMEOUT_MS = Number(process.env.PAYMENTS_ADK_TIMEOUT_MS ?? "60000");

// ── Sync stub removed ────────────────────────────────────────────────────────
// handlePaymentsRpc (sync) was removed: it returned a literal "__ASYNC__" string
// as the result, which is a nonsensical response. All callers must use
// handlePaymentsRpcAsync instead.

export async function handlePaymentsRpcAsync(
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
      // Stable per-request turnId so tool retries within this RPC call are
      // idempotent (same key → replay, no duplicate PaymentIntent rows).
      //
      // Customer path (Cloud Tasks retry fix): the create_payment_link tool in
      // customer-agent-tools-checkout.ts derives a deterministic contextId from
      // the inbound WhatsApp messageId and sends it here. Using that value as
      // turnId makes buildLinkIdempotencyKey produce the same key on every retry
      // of the same Cloud Tasks task → second call is a replay, no double charge.
      //
      // Owner path: no contextId is passed → contextId is a fresh randomUUID()
      // (generated above), so turnId stays scoped to this single RPC invocation
      // as before. The owner fast-path is not retry-vulnerable (deterministic NLU).
      //
      // The contextId value extracted above is either: (a) the messageId-derived
      // stable 32-char hex from the customer path, or (b) a fresh randomUUID()
      // for the owner path. Using it directly as turnId is safe for both cases.
      const turnId = contextId;
      // Structured data extracted from create_payment_link tool result — avoids
      // relying on URL extraction from prose (which fails when Gemini omits the URL).
      let capturedPaymentIntentId: string | null = null;
      let capturedCheckoutUrl: string | null = null;
      // Instructions for alias/CBU providers (no checkoutUrl in this case).
      let capturedInstructions: string | null = null;

      // Prefetch business fields + mpConnection via the core internal endpoint.
      // Phase 2 S3: HTTP call to GET /api/internal/agents/biz-snapshot instead
      // of direct Prisma reads — removes one direct-DB dependency from the agent.
      // On any failure (network/timeout/non-200), BizPrefetchHttpError is thrown
      // and we return a clean RPC error: a payment flow must not continue without
      // a valid business snapshot.
      const businessId = ctx?.businessId ?? null;
      let actorUserId: string | null = null;
      let bizSnapshot: BizSnapshot | null = null;
      if (businessId) {
        try {
          ({ actorUserId, bizSnapshot } = await prefetchBizSnapshot(businessId));
        } catch (prefetchError) {
          const isFetchErr = prefetchError instanceof BizPrefetchHttpError;
          cloudLog({
            severity: "ERROR",
            component: "A2A",
            action: "PAYMENTS_RPC_BIZ_PREFETCH_ERROR",
            a2a_transfer: false,
            message: "biz-snapshot prefetch failed — returning RPC error",
            data: {
              businessId,
              errorName: prefetchError instanceof Error ? prefetchError.name : "NonError",
              errorMessage: prefetchError instanceof Error ? prefetchError.message : String(prefetchError),
              httpStatus: isFetchErr ? prefetchError.status : undefined,
            },
          });
          return rpcError(body.id, RPC_ERRORS.INTERNAL_ERROR);
        }
      }

      const agent = createPaymentsAgent({ businessId, actorUserId, turnId, bizSnapshot });

      const { replyText: rawReplyText, error } = await runRpcAgent({
        agent,
        appName: "velora-payments-agent",
        userId: "payments-rpc-call",
        message: text,
        timeoutMs: PAYMENTS_ADK_TIMEOUT_MS,
        // Google-recommended infinite-loop protection: cap LLM invocations
        // per turn so the model cannot enter a retry loop.
        // 10 covers the canonical happy path on thinking-enabled models —
        // thinking pass + tool call + tool result + final text = 4 minimum,
        // with headroom for retry/clarify on tool error. The previous cap
        // of 2 silently dropped responses on Gemini 2.5 Pro because each
        // thinking pass counts as one LLM call (invocation_context increments
        // numberOfLlmCalls on every callLlmAsync), so call 3 (the final
        // text turn) threw "Max number of llm calls limit of 2 exceeded"
        // inside runAndHandleError. ADK converts that throw into an error
        // event with no content, which llm_agent.js:455 lets fall through
        // without yielding — drain loop sees zero events and replyText
        // stays empty ("Sin respuesta del modelo.").
        // The 60s PAYMENTS_ADK_TIMEOUT_MS is the real backstop.
        // maxToolCallRetries is NOT a valid RunConfig field (confirmed via
        // @google/adk dist/types/agents/run_config.d.ts — interface only has
        // maxLlmCalls, pauseOnToolCalls, streamingMode, etc.). B10 added it
        // believing ADK docs mentioned it, but the runtime ignores unknown keys
        // (spread passthrough in createRunConfig). Removed to avoid confusion.
        maxLlmCalls: 10,
        // Exit on first final-response — trailing ADK events (trace/metadata)
        // can stall the loop until the Vertex stream times out (~60s).
        // finally block calls events.return() to release the stream.
        breakOnFirstFinalResponse: true,
        // Capture create_payment_link tool results before the final-response
        // check — ADK emits function-response events before the final text.
        onFunctionResponse: ({ name, response }) => {
          if (name === "create_payment_link" && response && capturedPaymentIntentId === null) {
            if (typeof response.paymentIntentId === "string") {
              capturedPaymentIntentId = response.paymentIntentId;
            }
            if (typeof response.checkoutUrl === "string") {
              capturedCheckoutUrl = response.checkoutUrl;
            }
            if (typeof response.instructions === "string") {
              capturedInstructions = response.instructions;
            }
          }
        },
      });

      let replyText = rawReplyText;

      if (error !== null) {
        // Classify and log — shared helper emits PAYMENTS_AGENT_TIMEOUT /
        // PAYMENTS_AGENT_MAX_LLM_CALLS / PAYMENTS_AGENT_RUNNER_ERROR action codes.
        const classified = handleRpcRunnerError(error, "Payments", body, contextId, businessId, PAYMENTS_ADK_TIMEOUT_MS);
        if (classified.earlyResponse !== null) return classified.earlyResponse;
        replyText = classified.replyText;
      } else {
        // Silent drain: ADK converts internal throws (maxLlmCalls, safety filter)
        // into no-content error events. PAYMENTS_AGENT_EMPTY_DRAIN gives alerting a hook.
        if (!replyText && capturedPaymentIntentId === null) {
          logRpcAgentEmptyDrain("Payments", businessId, contextId);
        }

        // C-2: hallucination guard — Wiesinger §3.3 + ADK validation patterns.
        // Mode from SUB_AGENT_HALLUCINATION_GUARD_MODE (default: enforce).
        if (replyText) {
          const g = applySubAgentHallucinationGuard(
            replyText,
            { paymentIntentId: capturedPaymentIntentId, customerName: null },
            { businessId, agentName: "PaymentsAgent" },
          );
          if (g.blocked) replyText = "No pude confirmar el ID del pago — verificá en Pagos.";
        }
      }

      // Structured reply: errorCode (V-7) + paymentIntentId/checkoutUrl (V-8) +
      // instructions for alias/CBU providers (V-9) — all backward compatible.
      const errorCode = extractPaymentsErrorCode(replyText);
      const parts: A2APart[] = [
        { kind: "text", text: replyText || "Sin respuesta del modelo." },
        ...(errorCode ? [{ kind: "data" as const, data: { errorCode } }] : []),
        ...(capturedPaymentIntentId
          ? [{ kind: "data" as const, data: { paymentIntentId: capturedPaymentIntentId, checkoutUrl: capturedCheckoutUrl, instructions: capturedInstructions } }]
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
