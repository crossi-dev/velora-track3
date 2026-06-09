import "server-only";
// owner-assistant.ts — Owner Assistant ADK agent runner (Phase 1).
//
// ## Architecture
// The Owner Assistant is a direct-extraction agent that sits BEFORE the Supervisor
// in the owner pipeline. Instead of the 4-layer NLU stack (regex → classifier →
// Supervisor Pro → Ventas relay), the owner's free text goes directly to a Flash
// agent with typed FunctionTool schemas. The model fills the schema from the owner's
// message — no relay, no word-order loss.
//
// ## The bizcochuelo fix (end-to-end)
// Old path: "producto bizcochuelo 50 unidades 20 pesos"
//   → L1 miss (no verb prefix) → L2 classifies PRODUCT_CREATE (no dispatch) →
//   → Supervisor Pro calls call_ventas_agent({message: whole string}) →
//   → Ventas Flash sees relay string → name = whole string → bug
//
// New path (USE_OWNER_ASSISTANT=true):
//   → buildOwnerCatalogSummary() injects real catalog →
//   → Owner Assistant Flash sees typed schema + full sentence →
//   → calls create_product({ name: "bizcochuelo", price: 20, stock: 50 }) ✓
//
// ## AUTO mode (not mode=ANY) — see customer-agent.ts for full rationale.
// Source (verified HTTP 200 2026-05-29):
//   https://ai.google.dev/gemini-api/docs/function-calling
//
// ## Session service
// Uses ChatMessageSessionService with sessionId="owner-assistant" (stable per business).
// Loads source IN ("owner","assistant") — same as Supervisor session. Multi-turn memory
// is preserved across requests without InMemoryRunner discard.
// Source: https://adk.dev/sessions/state/ + https://google.github.io/adk-docs/sessions/session/
//
// ## Tenant isolation
// appName = businessId — same as Customer Agent. All DB queries scoped by businessId.
// Owner-only: this runner is invoked only when actorRole === "owner" (enforced in stage).

import { Runner, isFinalResponse, getFunctionCalls } from "@google/adk";
import { createAdkAgent } from "./agent-factory";
import { getAdkEmployeeModel } from "./gemini-config";
import { cloudLog } from "@/lib/cloud-logger";
import { buildOwnerAssistantTools } from "./owner-assistant-tools";
import { buildOwnerCatalogSummary } from "./owner-assistant-catalog";
import { OWNER_ASSISTANT_SYSTEM_PROMPT, OWNER_CATALOG_PLACEHOLDER } from "./owner-assistant.prompt";
import { ChatMessageSessionService } from "./session-service";
import type { OwnerAssistantInput, OwnerAssistantResult } from "./owner-assistant-types";

// Timeout for Owner Assistant — Flash model, 3 simple tool schemas, no A2A hops.
// Lower than Customer Agent (90s) because there are no nested agent calls in Phase 1.
// Env override: OWNER_ASSISTANT_ADK_TIMEOUT_MS.
const OWNER_ASSISTANT_ADK_TIMEOUT_MS = Number(
  process.env.OWNER_ASSISTANT_ADK_TIMEOUT_MS ?? "20000",
);

/**
 * Run the Owner Assistant for a single owner turn.
 *
 * Returns a result with a toolCall (extracted intent) when the model called a tool,
 * or an empty toolCall when the model produced only a text reply. The pipeline stage
 * falls through to the Supervisor when toolCall is null.
 *
 * Stateless per-request — no shared mutable state between calls.
 * Tenant-scoped: businessId is the ADK appName + all DB queries use it.
 * Owner-only: callers must verify actorRole === "owner" before invoking.
 */
export async function runOwnerAssistant(
  input: OwnerAssistantInput,
): Promise<OwnerAssistantResult> {
  const { businessId, actorUserId, text } = input;

  // ── Catalog context injection ────────────────────────────────────────────────
  // Build compact catalog summary and inject into the instruction so the model
  // has real product/price/stock/supplier data on turn 1.
  // This prevents hallucination and helps distinguish create_product vs stock_load
  // (existing product → likely stock_load; new name → likely create_product).
  const catalogSummary = await buildOwnerCatalogSummary(businessId);

  const tools = buildOwnerAssistantTools(businessId);

  const agent = createAdkAgent({
    name: "velora_owner_assistant",
    description:
      "Owner Assistant: extracts create_product, stock_load, and adjust_stock intents " +
      "from the owner's free-text messages using typed function schemas. " +
      "Invoked before the Supervisor for these 3 intents when USE_OWNER_ASSISTANT=true.",
    model: getAdkEmployeeModel(), // Gemini Flash — same tier as Ventas today
    instruction: OWNER_ASSISTANT_SYSTEM_PROMPT.replaceAll(
      OWNER_CATALOG_PLACEHOLDER,
      catalogSummary,
    ),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- FunctionTool[] satisfies BaseTool[] at runtime.
    tools: tools as any[],
    generateContentConfig: {
      maxOutputTokens: 800,
      // NO toolConfig → Gemini defaults to AUTO mode. Do NOT set mode=ANY.
      // AUTO: model can emit text OR call a tool. ANY forces a tool call on every
      // turn — model can never emit a final text reply → empty-reply loop.
      // Same lesson learned in Customer Agent revert 2026-05-29.
      // Source: https://ai.google.dev/gemini-api/docs/function-calling
    },
  });

  // Stable sessionId per business owner — multi-turn memory across requests.
  // ChatMessageSessionService loads source IN ("owner","assistant") for this sessionId.
  // agentName "velora_owner_assistant" so replayed model-turn history carries the
  // correct Event.author (not the "velora_supervisor" default) — otherwise ADK
  // isEventFromAnotherAgent treats prior turns as foreign → EMPTY_REPLY.
  const sessionService = new ChatMessageSessionService(businessId, "velora_owner_assistant");
  const runner = new Runner({
    appName: businessId,
    agent,
    sessionService,
  });

  const userId = actorUserId;
  const sessionId = "owner-assistant";

  // Pre-create session so Runner.runAsync finds an existing session.
  // Same pattern as Customer Agent — prevents "Session not found" on first turn.
  await sessionService.createSession({
    appName: businessId,
    userId,
    sessionId,
    state: {},
  });

  let finalText = "";
  let extractedToolCall: OwnerAssistantResult["toolCall"] = null;
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(
      () =>
        reject(
          Object.assign(new Error("Owner Assistant timed out"), {
            name: "TimeoutError",
          }),
        ),
      OWNER_ASSISTANT_ADK_TIMEOUT_MS,
    );
  });

  const events = runner.runAsync({
    userId,
    sessionId,
    newMessage: { role: "user", parts: [{ text }] },
    runConfig: { maxLlmCalls: 5 },
  });

  const drainEvents = async () => {
    for await (const event of events) {
      // Extract tool calls from every event (not just final-response events).
      // The tool call events arrive before the final text response.
      const fnCalls = getFunctionCalls(event);
      if (fnCalls && fnCalls.length > 0) {
        const call = fnCalls[0];
        // The tool execute() already returns { intent, data, summary }.
        // But we also capture the raw args here in case the tool hasn't been
        // invoked yet (getFunctionCalls returns the LLM's requested call before
        // the framework executes the tool). We'll capture the tool RESULT below.
        if (!extractedToolCall && call?.name) {
          extractedToolCall = {
            intent: call.name,
            // args are the raw parameters the LLM sent — same shape as Zod input.
            data: (call.args ?? {}) as Record<string, unknown>,
            // summary will be overwritten by the tool response below if available.
            summary: `${call.name} called`,
          };
        }
      }

      // Check for tool RESPONSES in the event — these have the { intent, data, summary }
      // shape produced by buildIntentTool's execute function (ventas-agent-tools.ts).
      // getFunctionResponses would capture these, but the tool response is embedded in
      // the event content parts as functionResponse items. We check isFinalResponse for
      // the text, then look for tool results.
      const parts = event.content?.parts ?? [];
      for (const part of parts) {
        if (part.functionResponse?.response) {
          const toolResponse = part.functionResponse.response as Record<string, unknown>;
          // The execute fn in buildIntentTool returns { intent, data, summary }.
          if (
            typeof toolResponse.intent === "string" &&
            toolResponse.data &&
            typeof toolResponse.summary === "string"
          ) {
            extractedToolCall = {
              intent: toolResponse.intent,
              data: toolResponse.data as Record<string, unknown>,
              summary: toolResponse.summary,
            };
          }
        }
      }

      if (!isFinalResponse(event)) continue;
      for (const part of parts) {
        if (typeof part.text === "string" && part.text.length > 0) {
          finalText = part.text;
        }
      }
      break;
    }
  };

  try {
    await Promise.race([drainEvents(), timeoutPromise]);
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === "TimeoutError";
    cloudLog({
      severity: "ERROR",
      component: "OwnerAssistant",
      action: isTimeout ? "OWNER_ASSISTANT_TIMEOUT" : "OWNER_ASSISTANT_ERROR",
      a2a_transfer: false,
      message: isTimeout
        ? `Owner Assistant timed out after ${OWNER_ASSISTANT_ADK_TIMEOUT_MS}ms`
        : `Owner Assistant threw: ${err instanceof Error ? err.message : String(err)}`,
      data: { businessId, actorUserId },
    });
    // Return no toolCall → pipeline falls through to Supervisor.
    return { toolCall: null, text: "" };
  } finally {
    if (timeoutHandle !== null) clearTimeout(timeoutHandle);
    try {
      await events.return(undefined);
    } catch {
      /* already exhausted */
    }
  }

  if (!extractedToolCall && !finalText) {
    cloudLog({
      severity: "WARNING",
      component: "OwnerAssistant",
      action: "OWNER_ASSISTANT_NO_OUTPUT",
      a2a_transfer: false,
      message: "Owner Assistant produced no tool call and no text reply",
      data: { businessId, actorUserId },
    });
  }

  return {
    toolCall: extractedToolCall,
    text: finalText,
  };
}
