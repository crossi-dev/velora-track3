// Business logic for the Supervisor — extracted from route.ts.
// route.ts is now a thin HTTP adapter; all runner logic lives here.
// Consumers (owner-handler, employee-handler.stages-*) import from here,
// NOT from the route module.

import { cloudLog } from "@/lib/cloud-logger";
import { callFlashFallback, callGeminiDirect } from "./supervisor-runner.gemini-direct";
import { classifyIntentComplexity } from "./supervisor-intent-complexity";
import { callGemini, isRateLimitError } from "@/app/api/business-assistant/_lib/gemini-wrapper";
import { buildSupervisorPrompt } from "./supervisor-prompt-builder";
import { safeParseJson } from "./supervisor-parser";
import { stripFenceAndProse } from "./supervisor-fence-strip";
import { applySupervisorHallucinationGuard } from "./supervisor-hallucination-guard";
import { buildUserMessage } from "./supervisor-context-builder";
import { sanitizeUserInput } from "@/app/api/business-assistant/_lib/shared";
// NEW-SEC-3: use shared redactInput (covers CUIT pattern) instead of local copy.
import { redactInput } from "@/lib/redact-pii";
import type { SupervisorResponse } from "./supervisor-response";
import { supervisorAnswer } from "./supervisor-answer";
import type { SupervisorAnswerResult } from "./supervisor-answer";
import type { SupervisorCallContext } from "./supervisor-context-builder";
import { getAgentsBaseUrl } from "@/lib/agent-base-url";

export type { SupervisorResponse };
export type { OnboardingState, ActivePolicy, SupervisorCallContext } from "./supervisor-context-builder";
export { shouldBypassToSupervisor, isB1Escalation } from "./bypass-heuristics";
export { safeParseJson } from "./supervisor-parser";
// W4: re-export SSE chunk context so route-streaming.ts can import from one place.
export type { StreamChunkCallback } from "./supervisor-stream-context";
export { runWithStreamChunkContext, getStreamChunkCallback } from "./supervisor-stream-context";
import { getStreamChunkCallback } from "./supervisor-stream-context";
import { buildCapabilityStateDelta } from "./supervisor-runner.capabilities"; // Step 1.5b

// Feature flag — re-evaluado en cada call (no module-load capture).
// Default TRUE: ADK es el path activo (orchestrator feedback loop).
// USE_ADK=false desactiva explícitamente y vuelve a Gemini directo.
// Module-private: callers outside this module should not depend on ADK state.
function isAdkEnabled(): boolean {
  return process.env.USE_ADK !== "false";
}

// isAdkTransientError -- decides whether an ADK failure falls through to the
// direct-Gemini path or is rethrown immediately.
// Hard-rethrow: quota/auth errors (Gemini direct would fail the same way).
// Fall-through: all other errors -- SDK retryOptions handle repetition.
function isAdkTransientError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  if (
    /(401|403|400|404|429)/.test(msg) ||
    msg.includes("unauthorized") ||
    msg.includes("forbidden") ||
    msg.includes("quota") ||
    msg.includes("resource_exhausted")
  )
    return false;
  return true;
}

import { circuitAllowsRequest, circuitAllowsRequestFleet, circuitOnSuccess, circuitOnFailure, supervisorCircuit, CB_RECOVERY_TIMEOUT_MS, recordSemanticFailure, semanticCircuitIsOpen } from "./supervisor-circuit-breaker";
import { buildGeminiHistory } from "./supervisor-history-builder";
import { SCHEMA_VIOLATION_RETRY_LIMIT, trySupervisorSchemaRetry } from "./supervisor-runner-retry"; // Fix C: schema retry

export async function callSupervisor(
  text: string,
  context: SupervisorCallContext = {},
  { forceGeminiDirect = false }: { forceGeminiDirect?: boolean } = {},
): Promise<{ raw: string; usedModel: "gemini"; usedAdkDelegation: boolean; capturedPatternCIntents: Array<{ intent: string; data: unknown; summary: string }> }> {
  const bizId = context.businessId ?? "";
  // Wall-clock — Deadline Propagation (https://sre.google/sre-book/addressing-cascading-failures/).
  const requestStartedAt = Date.now();
  if (!circuitAllowsRequest() || !await circuitAllowsRequestFleet()) { // REG-1: fail-open on DB error
    cloudLog({
      severity: "WARNING",
      component: "Supervisor",
      action: "SUPERVISOR_CIRCUIT_REJECTED",
      a2a_transfer: false,
      message: `Supervisor circuit is OPEN — request rejected (state: ${supervisorCircuit.state})`,
      businessId: bizId,
      data: {
        state: supervisorCircuit.state,
        openedAt: supervisorCircuit.openedAt,
        recoveryMs: CB_RECOVERY_TIMEOUT_MS,
      },
    });
    throw Object.assign(new Error("Supervisor circuit open — request shed"), {
      name: "CircuitOpenError",
    });
  }

  // forceGeminiDirect bypasses ADK for this specific call without mutating
  // process.env (which would race across concurrent V8-isolate requests).
  const adkEnabled = !forceGeminiDirect && isAdkEnabled();
  const sanitizedText = sanitizeUserInput(text);
  const userMessage = buildUserMessage(sanitizedText, context);
  const systemPrompt = buildSupervisorPrompt(context.lang ?? "es-AR", adkEnabled, context.originPostalCode ?? null);

  const convHistory = context.conversationHistory ?? [];

  let adkDelegationUsed = false; // set when ADK runner used an in-band delegation tool
  let adkCapturedIntents: Array<{ intent: string; data: unknown; summary: string }> = [];

  const geminiHistory = buildGeminiHistory(convHistory);
  // COST-N-1: simple intents skip 2048-token thinking budget (zero false-negative risk).
  const intentComplexity = classifyIntentComplexity(sanitizedText);

  const geminiCall = async (): Promise<string> => {
    // W4: retrieve per-request chunk callback (non-null on the SSE streaming path).
    const onChunk = getStreamChunkCallback();

    if (adkEnabled) {
      try {
        const { runSupervisorAgentViaAdk } = await import("@/lib/adk/supervisor-agent");
        const appUrl = getAgentsBaseUrl();
        const apiKey = process.env.A2A_INTERNAL_API_KEY ?? process.env.A2A_SECRET;
        const capStateDelta = await buildCapabilityStateDelta(bizId || undefined); // Step 1.5b
        // History via ChatMessageSessionService.getSession (ADK session replay).
        // Manual prepend would double-inject prior turns. https://adk.dev/sessions/session/
        const adkResult = await runSupervisorAgentViaAdk({
          systemPrompt,
          userMessage,
          businessId: bizId,
          sessionId: bizId || undefined,
          thinkingBudgetOverride: intentComplexity === "simple" ? 0 : undefined,
          onChunk: onChunk ?? undefined,
          stateDelta: Object.keys(capStateDelta).length > 0 ? capStateDelta : undefined, // Step 1.5b
          toolContext: bizId
            ? {
                // Delegation tools only. checkStock/businessQuery omitted: per-request
                // catalog data unavailable here; empty tool → "no hay stock" wrong answer.
                // callVentas off when USE_OWNER_ASSISTANT=true (OA handles mutations upstream).
                callContador: { businessId: bizId, appUrl, apiKey, requestStartedAt },
                ...(process.env.USE_OWNER_ASSISTANT !== "true" && {
                  callVentas: { businessId: bizId, appUrl, apiKey, requestStartedAt },
                }),
                // callPayments carries catalog so the tool can inject amountARS deterministically.
                // callPayments carries catalog for amountARS resolution.
                callPayments: {
                  businessId: bizId,
                  appUrl,
                  apiKey,
                  products: context.products?.map((p) => ({ id: p.name, name: p.name, price: p.price })),
                  requestStartedAt,
                },
                callLogistica: { businessId: bizId, appUrl, apiKey, requestStartedAt },
                callCommunications: { businessId: bizId, appUrl, apiKey, requestStartedAt },
                callCustomer: { businessId: bizId, appUrl, apiKey, requestStartedAt },
                ventasReportes: { businessId: bizId, currency: context.currency ?? "ARS" }, // ventas.consultar_ventas
                callCaja: { businessId: bizId, appUrl, apiKey, requestStartedAt }, // DB-only, always available
                callInventario: { businessId: bizId, appUrl, apiKey, requestStartedAt },
                // callEquipo + callMarketplace ENCAJONADOS 2026-05-25.
              }
            : undefined,
        });
        adkDelegationUsed = adkResult.usedAdkDelegation;
        adkCapturedIntents = adkResult.capturedPatternCIntents;
        return adkResult.text;
      } catch (adkErr) {
        // Hard-rethrow quota (429) and auth (401/403) -- falling through to
        // direct Gemini would waste quota or hide misconfiguration.
        // Transient errors fall through; SDK-level retryOptions handle repetition.
        if (!isAdkTransientError(adkErr)) {
          throw adkErr;
        }
        cloudLog({
          severity: "WARNING",
          component: "Supervisor",
          action: "ADK_IMPORT_FAILED",
          a2a_transfer: false,
          message: "ADK transient error -- falling back to Gemini direct",
          businessId: bizId,
          data: { error: adkErr instanceof Error ? adkErr.message : String(adkErr) },
        });
      }
    }
    // Direct-Gemini path (ADK disabled or transient ADK error).
    // W4: callGeminiDirect handles both streaming (sendMessageStream) and
    // buffered (sendMessage) modes based on whether onChunk is provided.
    // callFlashFallback fires when Pro is rate-limited (429).
    try {
      return await callGeminiDirect({
        systemPrompt, userMessage, geminiHistory,
        isSimple: intentComplexity === "simple",
        onChunk: onChunk ?? undefined,
      });
    } catch (err) {
      if (isRateLimitError(err)) {
        return callFlashFallback({ systemPrompt, userMessage, geminiHistory, bizId });
      }
      throw err;
    }
  };

  // REG-REL-3: auth/quota errors must NOT open the hard circuit — only infra failures do.
  function isAuthOrQuotaError(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    const msg = err.message.toLowerCase();
    return (
      /(401|403|429)/.test(msg) ||
      msg.includes("unauthorized") ||
      msg.includes("forbidden") ||
      msg.includes("quota") ||
      msg.includes("resource_exhausted")
    );
  }

  // Wrap with circuit-breaker callbacks. Only infrastructure failures (non-quota,
  // non-auth) open the circuit -- quota (429) requires flash fallback, not shedding.
  try {
    const { text: raw, usedModel } = await callGemini(geminiCall);
    circuitOnSuccess();
    return { raw, usedModel, usedAdkDelegation: adkDelegationUsed, capturedPatternCIntents: adkCapturedIntents };
  } catch (err) {
    // CircuitOpenError is a fast-fail we injected -- don't count it as a failure.
    const errName = (err as { name?: string }).name;
    const isCircuitFastFail = errName === "CircuitOpenError";
    if (!isCircuitFastFail && !isAuthOrQuotaError(err)) {
      circuitOnFailure(bizId);
    }
    throw err;
  }
}

// supervisorAnswer + SupervisorAnswerResult live in ./supervisor-answer.ts (extracted for size).
// Re-export so existing imports from this module keep working without changes.
export { supervisorAnswer } from "./supervisor-answer";
export type { SupervisorAnswerResult } from "./supervisor-answer";

// Wrapper consumido por business-assistant para escalación B1/B2.
export async function runSupervisor(
  text: string,
  context: SupervisorCallContext = {},
): Promise<SupervisorResponse | null> {
  if (!text || !text.trim()) return null;
  const runBizId = context.businessId ?? "";

  // Semantic soft circuit: ≥3 LLM degradation events in 60 s → route to Flash.
  // Uses forceGeminiDirect instead of mutating process.env.USE_ADK to avoid a
  // multi-tenant race where business A's semantic-circuit-open state suppresses
  // ADK for business B in the same V8 isolate.
  if (semanticCircuitIsOpen(runBizId)) {
    cloudLog({ severity: "WARNING", component: "Supervisor", action: "SUPERVISOR_SEMANTIC_CIRCUIT_FLASH_ROUTE",
      a2a_transfer: false, message: "Semantic soft circuit open — routing to Flash", businessId: runBizId, data: {} });
    const { raw, usedModel, usedAdkDelegation, capturedPatternCIntents } = await callSupervisor(text, context, { forceGeminiDirect: true });
    const parsed = safeParseJson(raw);
    if (!parsed) {
      const t = stripFenceAndProse((raw || "").trim());
      if (!t || t.length > 1500 || /^[{[]/.test(t)) return null;
      return { kind: "answer", answer: t, actions: [], clarification: null, notification: null, usedModel, usedAdkDelegation, capturedPatternCIntents };
    }
    return { ...applySupervisorHallucinationGuard(parsed, { usedModel }), usedModel, usedAdkDelegation, capturedPatternCIntents };
  }
  try {
    const { raw, usedModel, usedAdkDelegation, capturedPatternCIntents } = await callSupervisor(text, context);
    const parsed = safeParseJson(raw);
    if (!parsed) {
      // Graceful fallback: prose output surfaces as the answer; reject JSON-looking or
      // oversized fragments (hallucination risk). strip fences first (Bug 2026-05-27:
      // fenced JSON leaked as plain text when looksLikeJson returned false on the prefix).
      const trimmed = stripFenceAndProse((raw || "").trim());
      const looksLikeJson = /^[{[]/.test(trimmed);
      // Fix C: schema-correction re-prompt on ADK Zod failures (Wiesinger §4.1).
      // HIGH fix: prefer retry's capturedPatternCIntents (delegation may have happened
      // inside the retry); fall back to outer's if retry has none.
      if (looksLikeJson && usedAdkDelegation && SCHEMA_VIOLATION_RETRY_LIMIT > 0) {
        const retried = await trySupervisorSchemaRetry(trimmed, text, context, callSupervisor);
        if (retried) {
          const effectiveIntents = retried.capturedPatternCIntents.length > 0
            ? retried.capturedPatternCIntents
            : capturedPatternCIntents;
          return { ...retried, usedModel, usedAdkDelegation, capturedPatternCIntents: effectiveIntents };
        }
      }
      const useProse = trimmed.length > 0 && trimmed.length <= 1500 && !looksLikeJson;
      if (looksLikeJson && !usedAdkDelegation) {
        cloudLog({ severity: "ERROR", component: "Supervisor", action: "SUPERVISOR_SCHEMA_VIOLATION", a2a_transfer: false,
          message: "responseSchema active but model returned unparseable JSON — model regression or SDK bug",
          businessId: runBizId, data: { usedModel, rawPreview: trimmed.slice(0, 500), inputPreview: redactInput(text) } });
      }
      cloudLog({ severity: "WARNING", component: "Supervisor", action: "SUPERVISOR_PARSE_FAILED", a2a_transfer: false,
        message: useProse ? "non-JSON output — recovered as plain-text answer" : "non-JSON output — generic error",
        businessId: runBizId, data: { usedModel, recovered: useProse, inputPreview: redactInput(text), rawPreview: trimmed.slice(0, 500) } });
      if (!useProse) { recordSemanticFailure(runBizId); return null; }
      return { kind: "answer", answer: trimmed, actions: [], clarification: null, notification: null, usedModel, usedAdkDelegation, capturedPatternCIntents };
    }
    const prevAnswer = parsed.answer;
    const guarded = applySupervisorHallucinationGuard(parsed, { usedModel });
    if (guarded.answer !== prevAnswer && prevAnswer) recordSemanticFailure(runBizId);
    return { ...guarded, usedModel, usedAdkDelegation, capturedPatternCIntents };
  } catch (err) {
    cloudLog({ severity: "ERROR", component: "Supervisor", action: "SUPERVISOR_CALL_FAILED", a2a_transfer: false,
      message: "supervisor call threw — falling back to generic error",
      businessId: runBizId, data: { inputPreview: redactInput(text), error: err instanceof Error ? err.message : String(err) } });
    return null;
  }
}

// Re-export type alias for consumers that imported it from route.ts
export type { SupervisorNotificationLevel, SupervisorNotification } from "@/lib/supervisor-types";
