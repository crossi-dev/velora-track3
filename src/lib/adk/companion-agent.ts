// Velora Companion Agent — versión ADK.
// ADK orquesta el LLM call (Track 3 judging requirement).
// Feature flag USE_ADK=true activa este path; default = legacy.
// Fachada idéntica al path legacy: devuelve { text } al caller.

import { Agent, Runner, InMemorySessionService, isFinalResponse, getFunctionResponses } from "@google/adk";
import type { Event } from "@google/adk";
import { cloudLog } from "@/lib/cloud-logger";
import { getAdkCompanionModel } from "./gemini-config";
import {
  createRegisterSaleTool,
  createBusinessQueryTool,
  createEscalateToOwnerTool,
} from "./tools";
import { createSessionServiceWithFallback } from "./session-service";
import type { RegisterSaleToolContext } from "./tools/register-sale-tool";
import type { BusinessQueryToolContext } from "./tools/business-query-tool";
import type { EscalateToOwnerToolContext } from "./tools/escalate-to-owner-tool";
import { synthesizeFromToolResult, type ToolCallResult } from "./companion-agent.synthesize";
import { buildCompanionInstruction } from "./companion-agent.instruction";

interface RunCompanionAgentArgs {
  systemPrompt: string;
  history: Array<{ role: "user" | "model"; parts: Array<{ text: string }> }>;
  userMessage: string;
  /** Optional: request-scoped context for FunctionTool execution. */
  toolContext?: {
    registerSale: RegisterSaleToolContext;
    businessQuery: BusinessQueryToolContext;
    escalateToOwner: EscalateToOwnerToolContext;
  };
  /** Stable session identifier (employeeId) for session persistence. */
  sessionId?: string;
  /** businessId needed to scope the session service. */
  businessId?: string;
}

interface RunCompanionAgentResult {
  text: string;
}

const APP_NAME = "velora-companion-agent";

// ADK runner timeout for the Companion agent.
// Gemini Flash is faster than Pro, but the Companion request still competes
// inside the same Cloud Run 40s budget. 25s leaves ~15s for upstream overhead
// (auth, NLU, DB, post-model routing). A timeout here throws a TimeoutError
// that the caller (model.ts geminiCall wrapper) catches and retries via the
// direct-Gemini fallback path — identical to the Supervisor pattern.
// Exported so model.ts can derive ADK_TIMEOUT_MS = COMPANION_ADK_TIMEOUT_MS + 3_000,
// locking the invariant that the outer wrapper always exceeds the inner timeout.
export const COMPANION_ADK_TIMEOUT_MS = 25_000;

// Warm fallback message shown when the ADK runner times out AND no direct
// Gemini retry is available from the caller. In practice, model.ts always
// catches and retries — this string is the last-resort safety net.
const COMPANION_ADK_TIMEOUT_FALLBACK = "Dame un segundo, reintentá en un momento.";

/**
 * Ejecuta el Companion Agent vía ADK. Devuelve el texto plano que el LLM
 * generó — el caller sigue parseándolo igual que con el path legacy.
 *
 * El history se concatena al systemPrompt como contexto previo. ADK no
 * tiene un primitivo "history" separado; lo embebemos en la instruction
 * inicial (el chat history ya vive en Postgres y se inyecta por request).
 *
 * Session persistence: se usa Runner.runAsync con sessionId explícito.
 * Esto hace que ADK invoque getSession/createSession y appendEvent en el
 * ChatMessageSessionService (Postgres) o VertexAgentEngineSessionService,
 * según el feature flag USE_AGENT_ENGINE_SESSIONS. runEphemeral fue
 * reemplazado porque bypasaba la SessionService por completo.
 *
 * Refs:
 * - https://adk.dev/sessions/session/ (redirige desde google.github.io/adk-docs)
 * - Runner.runAsync vs runEphemeral: node_modules/@google/adk/dist/types/runner/runner.d.ts
 */
export async function runCompanionAgentViaAdk(
  args: RunCompanionAgentArgs,
): Promise<RunCompanionAgentResult> {
  const { systemPrompt, history, userMessage, toolContext, sessionId, businessId } = args;

  // Delegate business-context parsing and history rendering to the sibling
  // module to keep this file under the 300-line guardrail.
  const { fullInstruction } = buildCompanionInstruction({ systemPrompt, history });

  // Build FunctionTool list when request-scoped context is provided.
  // Tools are omitted when toolContext is absent (e.g. legacy callers or
  // test stubs) — the agent falls back to pure text generation as before.
  // Companion tool set: check_stock, register_sale, business_query only.
  // create_customer and create_purchase_request are owner-only intents;
  // their FunctionTools are excluded here so the RBAC gate cannot be bypassed
  // at the tool-execute level before any permission check runs.
  const tools = toolContext
    ? [
        createRegisterSaleTool(toolContext.registerSale),
        createBusinessQueryTool(toolContext.businessQuery),
        createEscalateToOwnerTool(toolContext.escalateToOwner),
      ]
    : [];

  // Pass instruction as a callback to skip ADK's injectSessionState templating.
  // If instruction is a string, ADK resolves every {identifier} against session
  // state and throws "Context variable not found" when user text contains braces
  // (e.g. "{product}" or JSON snippets). A callback bypasses this entirely.
  const instructionFn = () => fullInstruction;
  const agent = new Agent({
    name: "velora_companion",
    model: getAdkCompanionModel(),
    instruction: instructionFn,
    ...(tools.length > 0 ? { tools } : {}),
  });

  // Resolve session service: Postgres-backed (or Agent Engine) when businessId
  // is available; falls back to a per-request InMemorySessionService otherwise
  // (covers legacy callers and unit tests that don't supply businessId).
  //
  // IMPORTANT: InMemoryRunner hardcodes its own InMemorySessionService and
  // ignores any sessionService passed to it — it cannot be used here.
  // We use Runner directly so the wired sessionService is actually invoked.
  // Pass agent.name so replayed history events carry author="velora_companion" (not "model").
  // ADK contract: event.author must equal the agent name — https://adk.dev/events/
  const resolvedSessionService = businessId
    ? createSessionServiceWithFallback(businessId, agent.name)
    : new InMemorySessionService();

  const runner = new Runner({
    agent,
    appName: APP_NAME,
    sessionService: resolvedSessionService,
  });

  // Resolve the stable sessionId for this employee/business combination.
  // Format mirrors the supervisor convention: a stable string that scopes
  // ChatMessage queries to the right employee within the business.
  const userId = sessionId ?? "velora-anonymous";
  const resolvedSessionId = businessId
    ? `${businessId}:${userId}`
    : `ephemeral:${userId}`;

  // Ensure the session exists before running (getOrCreateSession is provided
  // by BaseSessionService and calls createSession when getSession returns
  // undefined — avoids a separate getSession + conditional createSession call).
  await resolvedSessionService.getOrCreateSession({
    appName: APP_NAME,
    userId,
    sessionId: resolvedSessionId,
  });

  // runAsync (not runEphemeral) causes ADK to call appendEvent on every event,
  // persisting interactions via the wired session service.
  const events = runner.runAsync({
    userId,
    sessionId: resolvedSessionId,
    newMessage: { role: "user", parts: [{ text: userMessage }] },
  });

  // Recorremos los events hasta encontrar el final con texto. ADK puede
  // emitir múltiples events (tool calls, intermediate); isFinalResponse
  // filtra solo el evento que representa la respuesta final del agente.
  //
  // Race against a hard timeout so a stalled Gemini Flash call does not hang
  // the Cloud Run instance until the platform kills it. On timeout a TimeoutError
  // propagates to model.ts, which falls back to the direct-Gemini path via its
  // existing try/catch — same pattern as supervisor-agent.ts.
  // The timer is always cleared in `finally` to avoid dangling handles.
  let finalText = "";
  // Captured tool call result (first one wins; only one tool fires per turn).
  let capturedToolResult: ToolCallResult | null = null;
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(
      () => reject(Object.assign(new Error("ADK companion timed out"), { name: "TimeoutError" })),
      COMPANION_ADK_TIMEOUT_MS,
    );
  });

  // Part 1: Drain the full ADK event stream.
  // On every event, check for function responses. If one is found and no
  // tool result has been captured yet, store it. If more than one tool fires
  // in the stream (unexpected for the Companion), keep the first and warn.
  // Never break early — the generator must complete to avoid a stream leak.
  const drainEvents = async () => {
    for await (const event of events as AsyncIterable<Event>) {
      // Capture function responses before the final-response check.
      const funcResponses = getFunctionResponses(event);
      if (funcResponses.length > 0) {
        if (capturedToolResult === null) {
          const fr = funcResponses[0];
          capturedToolResult = { name: fr.name ?? "", response: fr.response };
        } else {
          cloudLog({
            severity: "WARNING",
            component: "Companion",
            action: "ADK_MULTIPLE_TOOLS",
            a2a_transfer: false,
            message: "Multiple function responses in Companion stream — keeping first, ignoring rest",
            data: { extraTool: funcResponses[0].name },
          });
        }
      }
      if (!isFinalResponse(event)) continue;
      const parts = event.content?.parts ?? [];
      for (const part of parts) {
        if (typeof part.text === "string" && part.text.length > 0) {
          finalText = part.text;
        }
      }
    }
  };

  try {
    await Promise.race([drainEvents(), timeoutPromise]);
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === "TimeoutError";
    if (isTimeout) {
      cloudLog({
        severity: "WARNING",
        component: "Companion",
        action: "COMPANION_ADK_TIMEOUT",
        a2a_transfer: false,
        message: "Companion ADK runner timed out — caller should fall back to direct Gemini",
        businessId,
        data: { timeoutMs: COMPANION_ADK_TIMEOUT_MS },
      });
      // Surface the TimeoutError so model.ts can catch it and retry via
      // direct Gemini. If the caller does not handle it, the fallback text
      // provides a safe last-resort response.
      if (!finalText) finalText = COMPANION_ADK_TIMEOUT_FALLBACK;
      throw err;
    }
    throw err;
  } finally {
    if (timeoutHandle !== null) clearTimeout(timeoutHandle);
    // Close the async generator to release the underlying Gemini stream.
    // Without this, a timeout race leaves the generator open (stream leak).
    // .return() may throw if the generator already completed — guard it.
    try {
      await events.return(undefined);
    } catch {
      // Ignore: generator may already be exhausted or the ADK runner's
      // AsyncIterator may not implement .return() — both are safe to swallow.
    }
  }

  // Part 1 post-loop: if a tool fired, synthesize the AssistantTaskModelResponse
  // JSON from the tool result, intentionally overwriting finalText.
  //
  // WHY this takes precedence: ADK emits the function-response event BEFORE the
  // final-text event, so finalText at this point holds the model's conversational
  // rephrasing of the tool result — prose text that is NOT valid JSON and would
  // break JSON.parse in the downstream pipeline.  The synthesized JSON is always
  // correct; the conversational text from the model is discarded intentionally.
  if (capturedToolResult !== null) {
    finalText = synthesizeFromToolResult(capturedToolResult);
  }

  return { text: finalText };
}
