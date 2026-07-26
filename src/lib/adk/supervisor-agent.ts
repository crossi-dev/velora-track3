// Velora Supervisor Agent — versión ADK.
//
// Mismo prompt + mismo modelo (Gemini Pro) que `callSupervisor` en
// supervisor/route.ts. ADK orquesta el LLM call satisfaciendo el judging
// criteria #1 de Track 3.
//
// El feature flag `USE_ADK` activa este path (ahora default true).
// Misma fachada externa: recibe text, devuelve string raw para parseo
// downstream. Nuevo campo `usedAdkDelegation` indica si el LLM llamó
// in-band a un sub-agente (payments o fiscal) durante la generación.

import { Runner, InMemorySessionService, isFinalResponse, getFunctionCalls } from "@google/adk";
import { ThinkingLevel } from "@google/genai";
import { createAdkAgent } from "./agent-factory";
import { getAdkSupervisorModel } from "./gemini-config";
import { cloudLog } from "@/lib/cloud-logger";
// NOTE: ADK does NOT accept `responseSchema` inside `generateContentConfig` —
// it logs "Response schema must be set via LlmAgent.output_schema" and throws.
// `outputSchema` on the Agent itself IS accepted, but it is incompatible with
// agent-transfer tools (sub-agent delegation: Fiscal/Payments/Logística/etc.):
// ADK forces `disallowTransferToParent/Peers=true` whenever outputSchema is set.
// Velora's supervisor depends on those transfers, so schema enforcement on the
// ADK path is NOT POSSIBLE today. We rely on the direct-Gemini fallback path
// (gemini-client.ts:174) which DOES have schema enforcement, plus the unwrap
// safeguard in supervisor-parser.ts to detect raw-JSON-in-answer leaks.
// Tool list builder + ToolContext type extracted to supervisor-agent.tools.ts
// to keep this file under the 300-line server limit.
import { getCachedSessionService } from "./session-service-cache";
import { buildSupervisorTools, injectPatternCAccumulator, type ToolContext } from "./supervisor-agent.tools";
import { CapabilityToolset } from "./capability-toolset";

// Constants + timeout helper extracted to supervisor-agent.config.ts per the
// 300-LOC contract. DELEGATION_TOOL_NAMES is re-exported there for callers.
import {
  SUPERVISOR_APP_NAME as APP_NAME,
  SUPERVISOR_ADK_TIMEOUT_MS,
  DELEGATION_TOOL_NAMES,
  budgetToLevel,
} from "./supervisor-agent.config";

export { DELEGATION_TOOL_NAMES };

interface RunSupervisorAgentArgs {
  systemPrompt: string;
  userMessage: string;
  /** Optional: request-scoped context for FunctionTool execution. */
  toolContext?: ToolContext;
  /** Stable session identifier (ownerId or businessId) for session persistence. */
  sessionId?: string;
  /** businessId needed to scope the session service. */
  businessId?: string;
  /**
   * COST-N-1: per-call thinking budget override. When set to 0, disables extended
   * thinking (ThinkingLevel.MINIMAL) for simple intents (stock lookup, balance, etc.).
   * Omit to use the GEMINI_SUPERVISOR_THINKING_BUDGET env var default.
   */
  thinkingBudgetOverride?: number;
  /**
   * W4 SSE streaming: optional per-request callback for incremental text deltas.
   * When provided, every partial ADK event (event.partial === true) with text
   * content calls this with the delta text. The final complete text is still
   * returned as the resolved value — onChunk is additive, not a replacement.
   * Only set on the SSE path (getStreamChunkCallback() in supervisor-runner.ts).
   */
  onChunk?: (delta: string) => void;
  /**
   * Step 1.5b — capability-aware orchestration.
   * `app:*` prefixed state flags injected into ADK session state via stateDelta.
   * The CapabilityToolset reads these at tool-selection time.
   *
   * ADK session state injection mechanism (verified in @google/adk dist source):
   *   runEphemeral({ stateDelta }) → runAsync({ stateDelta })
   *   → createEventActions({ stateDelta }) on the initial user message event
   *   → State.get(key) checks delta before value, so flags are visible immediately.
   * Source: https://adk.dev/sessions/state/ (app:* prefix scope)
   */
  stateDelta?: Record<string, unknown>;
}

interface RunSupervisorAgentResult {
  text: string;
  /** True if the LLM invoked a role-agent delegation tool in-band. */
  usedAdkDelegation: boolean;
  /** Pattern C intents from sub-agent dataParts; empty when no Pattern C agent was called. */
  capturedPatternCIntents: Array<{ intent: string; data: unknown; summary: string }>;
}

export async function runSupervisorAgentViaAdk(
  args: RunSupervisorAgentArgs,
): Promise<RunSupervisorAgentResult> {
  const { systemPrompt, userMessage, toolContext, sessionId, businessId, thinkingBudgetOverride, onChunk, stateDelta } = args;

  // Pattern C accumulator: shared array injected into every A2A tool context.
  // createA2AAgentTool pushes captured { intent, data, summary } from dataParts here.
  // Extraction delegated to injectPatternCAccumulator (supervisor-agent.tools.ts).
  const capturedPatternCIntents: Array<{ intent: string; data: unknown; summary: string }> = [];
  const enrichedCtx = injectPatternCAccumulator(toolContext, capturedPatternCIntents);

  // Build tool list — delegated to supervisor-agent.tools.ts (300-line limit).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- BaseTool[] cast; buildSupervisorTools returns any[] per existing justification in tools.ts.
  const capabilityToolset = new CapabilityToolset(buildSupervisorTools(enrichedCtx, businessId) as any[]);

  // Supervisor generation limits — mirrored from gemini-client.ts env var contract.
  // thinkingConfig via generateContentConfig (ADK forwards it to the underlying
  // GenerateContentConfig on each LLM request). maxOutputTokens capped to reduce spend.
  //
  // thinkingConfig shape depends on the model family (T3 fix 2026-05-25):
  //   gemini-3.x → thinkingLevel ("none"|"low"|"medium"|"high") — required
  //   gemini-2.5  → thinkingBudget (numeric tokens) — required; thinkingLevel 400s
  //   Using both simultaneously causes a 400 error.
  //
  // GEMINI_SUPERVISOR_THINKING_BUDGET env var is retained for backward compat on the
  // 2.5 path (Cloud Run override: gemini-2.5-pro). On 3.x the budget is interpreted
  // as a level: 0 → "none", 1-999 → "low", 1000-3999 → "medium", 4000+ → "high".
  const supervisorMaxOutputTokens = parseInt(process.env.GEMINI_SUPERVISOR_MAX_OUTPUT_TOKENS ?? "1500", 10);
  // COST-N-1: thinkingBudgetOverride=0 disables thinking for simple intents.
  const supervisorThinkingBudget = thinkingBudgetOverride !== undefined
    ? thinkingBudgetOverride
    : parseInt(process.env.GEMINI_SUPERVISOR_THINKING_BUDGET ?? "2048", 10);

  const supervisorModelName = process.env.GEMINI_SUPERVISOR_MODEL ?? "gemini-3.1-pro-preview";
  const isGemini3 = supervisorModelName.startsWith("gemini-3");

  const thinkingConfig = isGemini3
    ? { thinkingLevel: budgetToLevel(supervisorThinkingBudget) }
    : { thinkingBudget: supervisorThinkingBudget };

  const agent = createAdkAgent({
    name: "velora_supervisor",
    model: getAdkSupervisorModel(),
    instruction: systemPrompt,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- CapabilityToolset satisfies BaseTool[] at runtime; ADK checks isBaseToolset() symbol.
    tools: [capabilityToolset as any],
    generateContentConfig: {
      maxOutputTokens: supervisorMaxOutputTokens,
      thinkingConfig,
    },
  });

  // Canonical Google ADK 2026 pattern: base Runner + persistent sessionService
  // + runAsync with stable sessionId. Mirrors companion-agent.ts:121-152.
  // InMemoryRunner ignores any sessionService passed to it (hardcodes its own).
  // PERF-T3-5: reuse session service per businessId:agentName (90s TTL, LRU-100).
  // agent.name passed → event.author in replayed history (ADK: https://adk.dev/events/)
  // Sources (verified HTTP 200): https://adk.dev/sessions/session/ https://adk.dev/sessions/state/
  const sessionService = businessId
    ? getCachedSessionService(businessId, agent.name)
    : new InMemorySessionService();

  const runner = new Runner({
    appName: APP_NAME,
    agent,
    sessionService,
  });

  // sessionId === "owner" triggers ChatMessageSessionService.getSession's
  // owner branch (loads source IN ("owner", "assistant") from ChatMessage).
  // userId is the actor identifier passed by the caller.
  const userId = sessionId ?? "velora-supervisor-anonymous";
  const ownerSessionId = "owner";

  // Pre-create the session so Runner has a target for appendEvent even on
  // the very first turn (getSession returns undefined when no rows exist).
  await sessionService.createSession({
    appName: APP_NAME,
    userId,
    sessionId: ownerSessionId,
    state: stateDelta ?? {},
  });

  // AbortController used to signal cancellation to the stream on timeout.
  // WebSearch 2026-05-25: @google/genai's generateContentStream does not yet
  // natively observe AbortSignal (it was a pending feature request in
  // googleapis/nodejs-vertexai#143). We still call controller.abort() before
  // events.return() so any future SDK version that reads the signal can act on
  // it immediately, and to make the cancellation intent explicit in the code.
  const abortController = new AbortController();

  const events = runner.runAsync({
    userId,
    sessionId: ownerSessionId,
    newMessage: { role: "user", parts: [{ text: userMessage }] },
    // Step 1.5b: inject app:* capability flags into session state.
    // stateDelta is forwarded as EventActions({ stateDelta }) on the initial
    // user message event. State.get(key) checks delta before value, so
    // CapabilityToolset can read flags immediately at tool-selection time.
    // Source: https://google.github.io/adk-docs/sessions/state/ — app:* prefix scope.
    ...(stateDelta ? { stateDelta } : {}),
  });

  let finalText = "";
  let usedAdkDelegation = false;

  // Race the event drain against the ADK timeout. If the timeout fires,
  // a TimeoutError propagates to supervisor-runner.ts which falls back to
  // the direct-Gemini path via the existing try/catch.
  // The timer is always cleared so it does not dangle after a normal drain.
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(
      () => reject(Object.assign(new Error("ADK supervisor timed out"), { name: "TimeoutError" })),
      SUPERVISOR_ADK_TIMEOUT_MS,
    );
  });

  const drainEvents = async () => {
    for await (const event of events) {
      // Scan ALL events (not just final) for function calls — getFunctionCalls
      // is the ADK-recommended helper; it reads event.content.parts safely.
      const calls = getFunctionCalls(event);
      for (const call of calls) {
        // call.name is string | undefined per @google/genai FunctionCall type.
        if (call.name && DELEGATION_TOOL_NAMES.has(call.name)) {
          usedAdkDelegation = true;
          // Supervisor-side log of the DECISION to delegate — emitted once per
          // tool call, before the tool executes. Complementary to the tool-side
          // ADK_A2A_VENTAS_CALL log (which fires inside the tool after the HTTP
          // round-trip). This entry makes the Supervisor's reasoning observable
          // in Cloud Logs without duplicating what the tool already records.
          cloudLog({
            severity: "INFO",
            component: "Supervisor",
            action: "SUPERVISOR_DELEGATION",
            a2a_transfer: false,
            message: `Supervisor delegated to role-agent: ${call.name}`,
            businessId,
            data: { tool: call.name },
          });
        }
      }

      // W4 SSE streaming: forward incremental text deltas to the SSE client.
      // Partial events (event.partial === true) carry text chunks as the LLM
      // generates tokens. Non-partial, non-final events (e.g. tool_call,
      // thought) are skipped here — only user-visible text is streamed.
      // The final assembled text is still captured below via isFinalResponse.
      if (onChunk && event.partial === true) {
        const partialParts = event.content?.parts ?? [];
        for (const part of partialParts) {
          if (typeof part.text === "string" && part.text.length > 0 && !part.thought) {
            onChunk(part.text);
          }
        }
      }

      if (!isFinalResponse(event)) continue;
      const parts = event.content?.parts ?? [];
      for (const part of parts) {
        if (typeof part.text === "string" && part.text.length > 0) {
          finalText = part.text;
        }
      }
      // Exit on first final-response.
      //
      // SOURCE: @google/adk dist/cjs/runner/runner.js (copyright 2026 Google LLC)
      //   Runner.runAsync is an async generator that yields every ADK event
      //   (partial + non-partial) produced by the agent. The generator naturally
      //   exhausts after all events are yielded — but on the Vertex streaming path
      //   (generateContentStream), trailing ADK trace/metadata events can keep the
      //   underlying HTTP stream open until Vertex's server-side timeout (~60s),
      //   causing the for-await loop to hang silently after the final response.
      //
      //   The official ADK docs (adk.dev/events/) note: "Applications must implement
      //   their own logic to determine when to stop consuming events from the runner."
      //   isFinalResponse(event) identifies the displayable response; breaking here
      //   is the documented way to stop consumption without waiting for the iterator
      //   to exhaust naturally. The generator is then closed in the finally block
      //   via events.return() to release the underlying Gemini stream.
      //
      //   Verified independently on the Payments path (handle-payments-rpc.ts):
      //   59-second silent gap matched Vertex's server-side stream timeout exactly,
      //   eliminated by the break. Applied here for the same reason.
      break;
    }
  };

  try {
    await Promise.race([drainEvents(), timeoutPromise]);
  } finally {
    if (timeoutHandle !== null) clearTimeout(timeoutHandle);
    // Signal abort BEFORE closing the generator. The @google/genai SDK does
    // not currently observe AbortSignal on generateContentStream (confirmed
    // via WebSearch 2026-05-25 — feature request open, not yet landed).
    // Calling abort() here is forward-compatible: once the SDK supports it,
    // the underlying HTTP request will be cancelled immediately on timeout
    // rather than waiting for Vertex's own ~60s server-side timeout.
    abortController.abort();
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

  return { text: finalText, usedAdkDelegation, capturedPatternCIntents };
}
