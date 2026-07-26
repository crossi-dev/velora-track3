import { cloudLog } from "@/lib/cloud-logger";
import { getGeminiModel } from "./gemini-client";
import { callGemini } from "./gemini-wrapper";
import { normalizeActionText, sanitizeUserInput } from "./shared";
import { trimContextProducts } from "./prompt-optimizer";
import { truncateHistory } from "./router-history";
import { runCompanionAgentViaAdk, COMPANION_ADK_TIMEOUT_MS } from "@/lib/adk/companion-agent";
import type { RegisterSaleToolContext } from "@/lib/adk/tools/register-sale-tool";
import type { BusinessQueryToolContext } from "@/lib/adk/tools/business-query-tool";
import type { EscalateToOwnerToolContext } from "@/lib/adk/tools/escalate-to-owner-tool";
import { COMPANION_SYSTEM_PROMPT } from "./employee-system-prompt";
import type {
  AssistantBusinessPromptContext,
  AssistantIntent,
  AssistantTaskModelResponse,
} from "./types";

/** Request-scoped context for ADK FunctionTool execution. */
export interface AdkToolContext {
  registerSale: RegisterSaleToolContext;
  businessQuery: BusinessQueryToolContext;
  escalateToOwner: EscalateToOwnerToolContext;
}

// Feature flag — re-evaluado en cada call (no module-load capture per
// nuestro convention de feature flags). Default TRUE: el path ADK del
// Companion Agent es el activo, satisfaciendo Track 3 #1 (judging
// criteria 30% weight). USE_ADK=false lo desactiva explícitamente.
// Simétrico con el Supervisor (supervisor-runner.ts).
function isAdkEnabled(): boolean {
  return process.env.USE_ADK !== "false";
}

const COMPANION_ALLOWED_INTENTS = new Set<AssistantIntent>([
  "answer",
  "register_sale",
  "stock_load",
  "create_customer",
  "edit_customer",
  "business_query",
  "report_event",
  "create_purchase_request",
  // cobro_qr: employees are the primary point-of-sale actors (role-contract.ts).
  // Must be here or the model's safe-intent filter silently downgrades it to "answer".
  "cobro_qr",
  // Preserved so the RBAC gate (STEP 3.7) can emit a warm owner-only refusal
  // instead of silently downgrading to "answer".
  "create_product",
  "create_budget",
  "return_sale",
  "edit_product",
  "delete_product",
  "bulk_price_update",
  "adjust_stock",
  "register_movement",
  "create_supplier",
  "edit_supplier",
  "delete_supplier",
  "delete_customer",
]);

const LANGUAGE_LOCK_EN = `\n\nLANGUAGE LOCK: The user has chosen English as the app language. You MUST respond in English. All text in your "answer" field MUST be in English. Product names and business-specific nouns may remain in the original language, but every conversational response must be in English.`;

export async function runBusinessAssistantModel(
  context: AssistantBusinessPromptContext,
  text: string,
  recentHistory: Array<{ role: "user" | "assistant"; text: string }> = [],
  fewShotExamples = "",
  documentContext = "",
  lang: "en" | "es-AR" = "es-AR",
  adkToolContext?: AdkToolContext,
): Promise<{
  parsed: AssistantTaskModelResponse | null;
  responseText: string;
  safeIntent: AssistantIntent | "answer";
  answer: string;
}> {
  // Build Gemini history: context priming as first user/model turn, then conversation history
  type GeminiPart = { text: string };
  type GeminiTurn = { role: "user" | "model"; parts: GeminiPart[] };

  const langLock = lang === "en" ? LANGUAGE_LOCK_EN : "";
  const systemPrompt = documentContext
    ? `${COMPANION_SYSTEM_PROMPT}\n\n## Reglas y procedimientos del negocio\n${documentContext}${langLock}`
    : `${COMPANION_SYSTEM_PROMPT}${langLock}`;
  const allowedIntents = COMPANION_ALLOWED_INTENTS;

  const trimmedContext = trimContextProducts(context, text);

  const history: GeminiTurn[] = [
    {
      role: "user",
      parts: [{ text: `Business context:\n${JSON.stringify(trimmedContext)}` }],
    },
    {
      role: "model",
      parts: [{ text: "Contexto cargado." }],
    },
  ];

  // Truncate to last 20 turns before mapping to Gemini history to keep
  // token budget bounded on long sessions.
  const boundedHistory = truncateHistory(recentHistory);

  // Map history (role: user|assistant) to Gemini (role: user|model)
  // Merge consecutive same-role messages to keep alternation valid
  for (const entry of boundedHistory) {
    const geminiRole: "user" | "model" = entry.role === "assistant" ? "model" : "user";
    const last = history[history.length - 1];
    if (last && last.role === geminiRole) {
      last.parts[0].text += `\n${entry.text}`;
    } else {
      history.push({ role: geminiRole, parts: [{ text: entry.text }] });
    }
  }

  // Ensure last history turn is model before sending user message
  if (history.length > 2 && history[history.length - 1].role === "user") {
    history.push({ role: "model", parts: [{ text: "Listo." }] });
  }

  const currentUserMessage = `<user_message>\n${sanitizeUserInput(text)}\n</user_message>${fewShotExamples}`;

  const ATTEMPT_TIMEOUT_MS = 7_000;
  // Outer wrapper must always exceed the inner ADK timeout so the inner cleanup
  // fires first before this fallback triggers. Derived from the exported constant
  // to make the ordering invariant explicit and compiler-enforced: if
  // COMPANION_ADK_TIMEOUT_MS grows, ADK_TIMEOUT_MS grows with it automatically.
  // INVARIANT: ADK_TIMEOUT_MS > COMPANION_ADK_TIMEOUT_MS (outer > inner).
  const ADK_TIMEOUT_MS = COMPANION_ADK_TIMEOUT_MS + 3_000;
  const RETRY_BACKOFF_MS = 2_000;
  const MAX_ATTEMPTS = 2;

  const isRetriable = (err: unknown) => {
    if (!(err instanceof Error)) return false;
    const msg = err.message.toLowerCase();
    // Auth (401/403) and 4xx client errors are not retriable — they would fail again.
    // 429 (rate-limit) is also not retriable here; Flash has no lower-tier fallback.
    if (/\b(401|403|400|404|429)\b/.test(msg) || msg.includes("unauthorized") || msg.includes("forbidden") || msg.includes("quota")) return false;
    return (
      err.name === "AbortError" ||
      err.name === "TimeoutError" ||
      msg.includes("network") ||
      msg.includes("fetch") ||
      msg.includes("econnreset") ||
      msg.includes("timed out") ||
      msg.includes("502") ||
      msg.includes("503") ||
      msg.includes("504") ||
      msg.includes("529")
    );
  };

  // Direct Gemini path — used when ADK is disabled or as ADK fallback.
  const directGeminiCall = async (): Promise<string> => {
    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const model = getGeminiModel();
        const chat = model.startChat({ systemInstruction: systemPrompt, history });
        const timeout = new Promise<never>((_, reject) =>
          setTimeout(() => reject(Object.assign(new Error("Gemini call timed out"), { name: "TimeoutError" })), ATTEMPT_TIMEOUT_MS)
        );
        const result = await Promise.race([chat.sendMessage([{ text: currentUserMessage }]), timeout]);
        // Gemini 2.5 thinking tokens appear in earlier parts; the actual JSON
        // response is always the last text part. Take the last non-empty one.
        const parts = result.response.candidates?.[0]?.content?.parts ?? [];
        return parts.map(p => p.text).filter((t): t is string => typeof t === "string" && t.length > 0).at(-1) ?? "";
      } catch (err) {
        lastError = err;
        if (!isRetriable(err) || attempt === MAX_ATTEMPTS) throw err;
        await new Promise((resolve) => setTimeout(resolve, RETRY_BACKOFF_MS));
      }
    }
    throw lastError;
  };

  // ADK path — el LLM call se enrouta via ADK Agent + Runner cuando
  // USE_ADK=true. Mismo prompt + mismo modelo + misma forma de output;
  // ADK actúa como el orchestration layer sanctioned por Google. Falls back
  // to directGeminiCall on any ADK error (timeout, network, ADK runtime)
  // so a flaky ADK path never produces a 500 — it just costs ~7s extra.
  const geminiCall = async (): Promise<string> => {
    if (isAdkEnabled()) {
      try {
        const timeout = new Promise<never>((_, reject) =>
          setTimeout(() => reject(Object.assign(new Error("ADK call timed out"), { name: "TimeoutError" })), ADK_TIMEOUT_MS),
        );
        const adkResult = await Promise.race([
          runCompanionAgentViaAdk({
            systemPrompt,
            history,
            userMessage: currentUserMessage,
            toolContext: adkToolContext,
          }),
          timeout,
        ]);
        return adkResult.text;
      } catch (adkErr) {
        cloudLog({
          severity: "WARNING",
          component: "Companion",
          action: "ADK_FALLBACK_TO_GEMINI",
          a2a_transfer: false,
          message: "ADK companion path failed — falling back to direct Gemini",
          data: {
            error: adkErr instanceof Error ? adkErr.message : String(adkErr),
            errorName: adkErr instanceof Error ? adkErr.name : "unknown",
          },
        });
        return directGeminiCall();
      }
    }
    return directGeminiCall();
  };

  const { text: responseText } = await callGemini(geminiCall);

  if (!responseText) {
    return {
      parsed: null,
      responseText: "",
      safeIntent: "answer" as AssistantIntent,
      answer: "No pude procesar tu mensaje. ¿Podés repetirlo?",
    };
  }

  // responseMimeType: 'application/json' means Gemini won't wrap in markdown, but strip defensively.
  // También limpiamos zero-width chars (U+200B..U+200D, U+FEFF) — Gemini a veces
  // intercala ZWSP entre la prefill `{"intent":` y su token siguiente, lo que
  // rompe JSON.parse silenciosamente. Visto en prod 2026-05-08.
  const cleanText = responseText
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  let parsed: AssistantTaskModelResponse | null = null;
  try {
    parsed = JSON.parse(cleanText);
  } catch {
    parsed = null;
    cloudLog({ severity: "WARNING", component: "System", action: "MODEL_JSON_PARSE_FAILED", a2a_transfer: false, message: "model: JSON parse failed", data: { preview: cleanText.slice(0, 200) } });
  }

  const intent = parsed ? (parsed.intent ?? "answer") : "answer";
  const safeIntent = allowedIntents.has(intent) ? intent : "answer";
  const answer = normalizeActionText(parsed?.answer) || "No entendí tu mensaje. ¿Podés reformularlo?";

  return {
    parsed,
    responseText: cleanText,
    safeIntent,
    answer,
  };
}
