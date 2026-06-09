// OnboardingAgent — runner.
//
// Onboarding v3 (2026-06-04): the agent owns TWO currently_due slots —
// business_name + catalog_ready. Payment / shipping / WhatsApp moved to the
// SetupChecklist dashboard card (eventually_due). See ALLOWED_TOOLS below.
//
// Session.state pattern: injects currently_due as structured JSON context
// so the LLM knows which slot is still pending — without manual string
// serialization. Source: https://google.github.io/adk-docs/sessions/state/
//
// FunctionTool dispatch: validates the LLM-emitted tool_name, dispatches to
// the matching handler (onboarding-agent.tools.ts), and composes the final
// output (including any clientAction produced by the tool).
// Source: https://google.github.io/adk-docs/tools/function-tools/
//
// Slot-filling: onboarding-agent.slot-filling.ts — ack + auto-advance per turn.
// matchedTurn removed: the LLM picks the tool based on currently_due.
// Failure modes:
//   Timeout → OnboardingAgentTimeoutError
//   Empty/non-JSON output → OnboardingAgentParseError
//   Schema violation → OnboardingAgentValidationError

import { GoogleGenAI, HarmCategory, HarmBlockThreshold } from "@google/genai";
import type { GenerateContentResponse } from "@google/genai";
import { cloudLog } from "@/lib/cloud-logger";
import {
  ONBOARDING_AGENT_MODEL,
  ONBOARDING_AGENT_VERTEX_LOCATION,
  ONBOARDING_AGENT_ADK_TIMEOUT_MS,
  CLIENT_ACTION_VALUES,
  CLIENT_ACTION_PANEL_VALUES,
} from "./onboarding-agent.contract";
import type { OnboardingAgentInput, OnboardingAgentOutput } from "./onboarding-agent.contract";
import { ONBOARDING_AGENT_PROMPT } from "./onboarding-agent.prompt";
import type { OnboardingCurrentlyDue } from "@/app/api/business-assistant/_lib/onboarding-session-state";
import {
  buildNextSlotPrompt,
  applyNextSlotAutoAdvance,
} from "./onboarding-agent.slot-filling";
// Re-export buildNextSlotPrompt for unit tests.
export { buildNextSlotPrompt } from "./onboarding-agent.slot-filling";
import {
  saveBusinessName,
  importCatalog,
} from "@/app/api/business-assistant/_lib/onboarding-agent.tools";
import type {
  ToolContext,
  SaveBusinessNameArgs,
  ImportCatalogArgs,
} from "@/app/api/business-assistant/_lib/onboarding-agent.tools";
import { executeBusinessSetupActions } from "@/app/api/supervisor/_lib/business-setup-actions";

const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT ?? "my-gcp-project";

const SAFETY_SETTINGS = [
  { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
  { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
  { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
  { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
];

// Allowed tool names the LLM may emit. Exported for unit tests.
// Onboarding v3 (2026-06-04): name + catalog only. Payment / shipping / WhatsApp
// moved to the SetupChecklist dashboard card (eventually_due) — the agent can no
// longer offer them, so it cannot re-introduce the forced-chain contradiction.
export const ALLOWED_TOOLS = new Set(["save_business_name", "import_catalog"]);
// Allowed clientAction values — derived from the canonical contract const so both paths
// can never diverge. Adding a new action in CLIENT_ACTION_VALUES updates this automatically.
const ALLOWED_CLIENT_ACTIONS = new Set<string>(CLIENT_ACTION_VALUES);
const ALLOWED_PANELS = new Set<string>(CLIENT_ACTION_PANEL_VALUES);

export class OnboardingAgentTimeoutError extends Error {
  constructor() { super("OnboardingAgent: Vertex AI call exceeded timeout"); this.name = "OnboardingAgentTimeoutError"; }
}
export class OnboardingAgentParseError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(`OnboardingAgent: ${message}`, options); this.name = "OnboardingAgentParseError";
  }
}
export class OnboardingAgentValidationError extends Error {
  constructor(message: string) { super(`OnboardingAgent: ${message}`); this.name = "OnboardingAgentValidationError"; }
}

let _client: GoogleGenAI | null = null;
function getClient(): GoogleGenAI {
  if (_client) return _client;
  const credentialsJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  const opts: ConstructorParameters<typeof GoogleGenAI>[0] = {
    vertexai: true, project: PROJECT_ID, location: ONBOARDING_AGENT_VERTEX_LOCATION,
  };
  if (credentialsJson) {
    try { opts.googleAuthOptions = { credentials: JSON.parse(credentialsJson) as Record<string, unknown> }; }
    catch { throw new Error("OnboardingAgent: GOOGLE_APPLICATION_CREDENTIALS_JSON is not valid JSON"); }
  }
  _client = new GoogleGenAI(opts);
  return _client;
}

/**
 * Builds user-content with currently_due injected as structured JSON
 * (ADK session.state pattern). Only the currently_due fields (name + catalog)
 * are sent — the LLM picks the tool based on which is null/false.
 */
function buildUserContent(
  input: OnboardingAgentInput,
  currentlyDue: OnboardingCurrentlyDue,
): string {
  const lines: string[] = [];
  lines.push("CURRENTLY_DUE (session.state):");
  lines.push(JSON.stringify(currentlyDue, null, 2));
  if (input.recentHistory.length > 0) {
    lines.push("", "CONVERSACIÓN RECIENTE:");
    for (const turn of input.recentHistory.slice(-6)) {
      lines.push(`${turn.role === "owner" ? "Dueño" : "Asistente"}: ${turn.text}`);
    }
  }
  lines.push("", `MENSAJE DEL DUEÑO: ${input.text}`);
  return lines.join("\n");
}

function logUsage(res: GenerateContentResponse): void {
  const usage = (res as { usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; cachedContentTokenCount?: number } }).usageMetadata;
  if (!usage) return;
  const promptTokens = usage.promptTokenCount ?? 0;
  const cachedTokens = usage.cachedContentTokenCount ?? 0;
  cloudLog({
    severity: "DEBUG", component: "System", action: "ONBOARDING_AGENT_USAGE", a2a_transfer: false,
    message: "OnboardingAgent usage",
    data: { model: ONBOARDING_AGENT_MODEL, promptTokens, candidatesTokens: usage.candidatesTokenCount ?? 0, cachedTokens, cacheHitRatio: promptTokens > 0 ? Math.round((cachedTokens / promptTokens) * 100) : 0 },
  });
}

// ── Intermediate LLM output shape (before tool dispatch) ─────────────────────

interface LlmRawOutput {
  answer: string;
  tool_name: string | null;
  // tool_args is free-form validated per-tool by each handler
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- validated per-tool in dispatch
  tool_args: Record<string, any> | null;
  chips: OnboardingAgentOutput["chips"];
}

/** Validates the raw LLM JSON against the intermediate schema. Exported for unit testing. */
export function validateRawOutput(raw: unknown): LlmRawOutput {
  if (typeof raw !== "object" || raw === null) throw new OnboardingAgentValidationError("output is not an object");
  const r = raw as Record<string, unknown>;
  if (typeof r.answer !== "string" || r.answer.length === 0) throw new OnboardingAgentValidationError("answer missing or empty");
  const toolName = r.tool_name ?? null;
  if (toolName !== null && (typeof toolName !== "string" || !ALLOWED_TOOLS.has(toolName))) {
    throw new OnboardingAgentValidationError(`tool_name '${String(toolName)}' not in allowlist`);
  }
  const toolArgs = r.tool_args ?? null;
  if (toolName !== null && (typeof toolArgs !== "object" || toolArgs === null)) {
    throw new OnboardingAgentValidationError("tool_args must be an object when tool_name is set");
  }
  return {
    answer: r.answer,
    tool_name: toolName as string | null,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- validated per-tool
    tool_args: toolArgs as Record<string, any> | null,
    chips: (r.chips ?? null) as OnboardingAgentOutput["chips"],
  };
}

/** Dispatches to the matching FunctionTool handler; merges clientAction into output.
 *
 * Slot-filling auto-advance: after any successful DB-write tool, computes the
 * next pending currently_due slot and injects its question+chips into the same
 * response. Ack + next-prompt in one turn — no stall between steps.
 *
 * Error policy: if a tool returns ok=false the runner throws OnboardingAgentValidationError
 * so the stage catch-block triggers the deterministic re-prompt. This prevents returning
 * the LLM's happy-path answer to the user when the DB write actually failed.
 */
async function dispatchTool(
  raw: LlmRawOutput,
  ctx: ToolContext,
  currentlyDue: OnboardingCurrentlyDue,
  state: OnboardingAgentInput["state"],
): Promise<OnboardingAgentOutput> {
  const base: OnboardingAgentOutput = { answer: raw.answer, chips: raw.chips };
  if (!raw.tool_name || !raw.tool_args) return base;

  if (raw.tool_name === "save_business_name") {
    const result = await saveBusinessName(raw.tool_args as SaveBusinessNameArgs, ctx);
    if (!result.ok) throw new OnboardingAgentValidationError(`save_business_name failed: ${result.error ?? "unknown"}`);
    // Advance: business_name is now set → next is catalog_ready
    const after: OnboardingCurrentlyDue = { ...currentlyDue, business_name: (raw.tool_args as SaveBusinessNameArgs).name };
    return applyNextSlotAutoAdvance(base, after);
  }
  if (raw.tool_name === "import_catalog") {
    const result = await importCatalog(raw.tool_args as ImportCatalogArgs, ctx);
    // file/photo paths return ok=true but set clientAction; the write hasn't happened yet (client-side).
    // paste/skip paths: if ok=false, trigger fallback so the owner can retry.
    if (!result.ok && !result.clientAction) throw new OnboardingAgentValidationError(`import_catalog failed: ${result.error ?? "unknown"}`);
    if (result.clientAction) return { ...base, clientAction: result.clientAction };
    // Partial paste success: override the LLM's answer with the real count so
    // the user sees the truth ("Cargué 7 de 10 — 3 fallaron") rather than
    // whatever the LLM hallucinated. Design §7.1.
    const baseWithCount = (result.successCount > 0 && result.totalCount > result.successCount)
      ? { ...base, answer: result.confirmation ?? base.answer }
      : base;
    // Catalog is now ready (skip or paste success) → both slots filled, slot-filling
    // returns null. The agent's answer carries the closing pitch to the card.
    const after: OnboardingCurrentlyDue = { ...currentlyDue, catalog_ready: true };
    // Phase 2 proactivity (design §5 Phase 2): stamp firstSalePromptShown=true so the
    // first-sale-nudge cron knows when the prompt was shown and can re-engage after 24h.
    // Only fires when PROACTIVE_ONBOARDING_ENABLED=true and the flag is not yet set.
    // Best-effort: a failure here must NOT block the response — the owner already saw
    // the closing pitch in the LLM's answer, so the stamp is a tracking side-effect.
    if (
      process.env.PROACTIVE_ONBOARDING_ENABLED === "true" &&
      !state.firstSalePromptShown
    ) {
      try {
        await executeBusinessSetupActions(
          [{ intent: "update_business_setup", data: { field: "firstSalePromptShown", value: true }, summary: "Primer venta prompt marcado (catalog complete)" }],
          ctx.businessId,
          ctx.actorUserId,
          `${ctx.idempotencySeed}|firstSalePromptShown`,
        );
      } catch {
        cloudLog({
          severity: "WARNING",
          component: "OnboardingAgent",
          action: "FIRST_SALE_PROMPT_STAMP_FAILED",
          a2a_transfer: false,
          message: "Failed to stamp firstSalePromptShown after catalog completion — non-blocking",
          businessId: ctx.businessId,
        });
      }
    }
    return applyNextSlotAutoAdvance(baseWithCount, after);
  }
  // Onboarding v3 (2026-06-04): connect_payment_method / connect_shipping_provider /
  // connect_whatsapp_business were REMOVED from the agent. Those integrations are
  // eventually_due — collected from the SetupChecklist dashboard card, not chat.
  // ALLOWED_TOOLS rejects them upstream, so they can never reach this dispatch.
  return base;
}

function validateClientAction(output: OnboardingAgentOutput): void {
  if (output.clientAction !== undefined && !ALLOWED_CLIENT_ACTIONS.has(output.clientAction)) {
    throw new OnboardingAgentValidationError(`clientAction '${output.clientAction}' not in allowlist`);
  }
  if (output.clientActionParams?.panel !== undefined && !ALLOWED_PANELS.has(output.clientActionParams.panel)) {
    throw new OnboardingAgentValidationError(`clientActionParams.panel '${output.clientActionParams.panel}' not in allowlist`);
  }
}

/** Main entry. The caller wraps timeouts/fallbacks. */
export async function runOnboardingAgent(
  input: OnboardingAgentInput,
  currentlyDue: OnboardingCurrentlyDue,
): Promise<OnboardingAgentOutput> {
  const userContent = buildUserContent(input, currentlyDue);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ONBOARDING_AGENT_ADK_TIMEOUT_MS);
  try {
    const client = getClient();
    const res = await client.models.generateContent({
      model: ONBOARDING_AGENT_MODEL,
      contents: [{ role: "user", parts: [{ text: userContent }] }],
      config: {
        systemInstruction: ONBOARDING_AGENT_PROMPT as never,
        temperature: 0,
        maxOutputTokens: 800,
        responseMimeType: "application/json",
        safetySettings: SAFETY_SETTINGS,
        // Flash with thinkingBudget=0 — 4-field setup is bounded; no multi-step reasoning needed.
        thinkingConfig: { thinkingBudget: 0 },
        abortSignal: controller.signal as never,
      },
    });
    logUsage(res);
    const raw = res.text ?? res.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    if (!raw || raw.trim().length === 0) throw new OnboardingAgentParseError("empty model output");
    let parsed: unknown;
    try { parsed = JSON.parse(raw); }
    catch (err) { throw new OnboardingAgentParseError(`JSON.parse failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err }); }
    const validated = validateRawOutput(parsed);
    const toolCtx: ToolContext = {
      businessId: input.businessId,
      actorUserId: input.actorUserId,
      idempotencySeed: `${input.inboundEventId ?? "onboarding-agent"}|${input.businessId}|${input.actorUserId}`,
    };
    const composed = await dispatchTool(validated, toolCtx, currentlyDue, input.state);
    validateClientAction(composed);
    return composed;
  } catch (err) {
    if (controller.signal.aborted) throw new OnboardingAgentTimeoutError();
    if (err instanceof OnboardingAgentParseError) throw err;
    if (err instanceof OnboardingAgentValidationError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new OnboardingAgentParseError(`network or Vertex error: ${message}`, { cause: err });
  } finally {
    clearTimeout(timer);
  }
}
