import { GoogleGenAI, HarmCategory, HarmBlockThreshold, ThinkingLevel } from "@google/genai";
import type { GenerateContentConfig, GenerateContentResponse } from "@google/genai";
import { EMPLOYEE_RESPONSE_SCHEMA, SUPERVISOR_RESPONSE_SCHEMA } from "./gemini-schemas";
import { GeminiModels } from "@/lib/gemini-models";
import { cloudLog } from "@/lib/cloud-logger";
import { budgetToLevel } from "@/lib/adk/supervisor-agent.config";

// Log Vertex usage metadata after every generateContent call so we have
// visibility into prompt caching effectiveness. Implicit caching on Gemini
// 2.5/3.x kicks in when a prompt has a stable ~32k+ token prefix; without
// logging cachedContentTokenCount we are blind to whether it is firing.
// Source: debt audit C4.
function logGeminiUsage(modelName: string, res: GenerateContentResponse): void {
  const usage = (res as { usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; cachedContentTokenCount?: number; thoughtsTokenCount?: number } }).usageMetadata;
  if (!usage) return;
  const promptTokens = usage.promptTokenCount ?? 0;
  const cachedTokens = usage.cachedContentTokenCount ?? 0;
  const cacheHitRatio = promptTokens > 0 ? Math.round((cachedTokens / promptTokens) * 100) : 0;
  // Severity INFO (not DEBUG): Cloud Run prod log ingestion drops DEBUG entries by
  // default, which would make cache-hit-ratio monitoring completely blind.
  // Per Google Cloud Logging docs (2026), DEBUG is excluded from the default
  // _Default log sink inclusion filter. INFO is the minimum level that reaches
  // Cloud Logging reliably. Per-call cost is acceptable — traffic is owner-driven,
  // not high-frequency (not 10K req/sec). M3: businessId injected for per-tenant
  // LLM cost attribution (no per-tenant visibility existed otherwise).
  cloudLog({
    severity: "INFO",
    component: "System",
    action: "GEMINI_USAGE",
    a2a_transfer: false,
    message: `${modelName} usage`,
    data: {
      model: modelName,
      promptTokens,
      candidatesTokens: usage.candidatesTokenCount ?? 0,
      cachedTokens,
      cacheHitRatio,
      thoughtsTokens: usage.thoughtsTokenCount ?? 0,
    },
  });
}

const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT ?? "my-gcp-project";
const COMPANION_LOCATION = process.env.VERTEX_LOCATION_COMPANION ?? "southamerica-east1";
const SUPERVISOR_LOCATION = process.env.VERTEX_LOCATION_SUPERVISOR ?? "us-south1";
const MODEL = GeminiModels.COMPANION;
const SUPERVISOR_MODEL = GeminiModels.SUPERVISOR;

export const SAFETY_SETTINGS = [
  { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
  { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
  { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
  { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
];

let _aiCompanion: GoogleGenAI | null = null;
let _aiSupervisor: GoogleGenAI | null = null;

function buildGenAI(location: string): GoogleGenAI {
  const credentialsJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  const opts: ConstructorParameters<typeof GoogleGenAI>[0] = { vertexai: true, project: PROJECT_ID, location };
  if (credentialsJson) {
    let credentials: Record<string, unknown>;
    try { credentials = JSON.parse(credentialsJson) as Record<string, unknown>; } catch (err) {
      throw new Error();
    }
    opts.googleAuthOptions = { credentials };
  }
  return new GoogleGenAI(opts);
}

function getAiCompanion(): GoogleGenAI { if (!_aiCompanion) _aiCompanion = buildGenAI(COMPANION_LOCATION); return _aiCompanion; }
function getAiSupervisor(): GoogleGenAI { if (!_aiSupervisor) _aiSupervisor = buildGenAI(SUPERVISOR_LOCATION); return _aiSupervisor; }

// Supervisor generation limits — both values are tunable via env vars (no redeploy needed).
// GEMINI_SUPERVISOR_MAX_OUTPUT_TOKENS: cap on output tokens (default 1500 — covers 99% of owner turns).
// GEMINI_SUPERVISOR_THINKING_BUDGET: thinking token budget (default 2048).
// Why 2048 (was 100): per Google 2026 docs the previous value of 100 was the worst of
// both worlds — thinking activated but capped before completion, producing truncated
// reasoning and downstream SUPERVISOR_PARSE_FAILED events. 2048 gives the Pro model
// enough budget for multi-step agentic reasoning (intent decomposition, deictic
// resolution, sub-agent routing). Output is still capped at 1500 tokens so total
// cost stays bounded. Use thinkingBudget=0 to disable, -1 for dynamic.
//
// thinkingConfig shape depends on the model family (T3 fix 2026-05-25):
//   gemini-3.x → thinkingLevel ("none"|"low"|"medium"|"high") — required
//   gemini-2.5  → thinkingBudget (numeric tokens) — required; thinkingLevel 400s
//   Using both simultaneously causes a 400 error.
//
// Budget-to-level mapping delegated to budgetToLevel() in supervisor-agent.config.ts
// (canonical, dedup 2026-05-29 — was duplicated as budgetToLevel here).
const SUPERVISOR_MAX_OUTPUT_TOKENS = parseInt(process.env.GEMINI_SUPERVISOR_MAX_OUTPUT_TOKENS ?? "1500", 10);
const SUPERVISOR_THINKING_BUDGET = parseInt(process.env.GEMINI_SUPERVISOR_THINKING_BUDGET ?? "2048", 10);

// Employee (Flash 3.x): disable thinking via ThinkingLevel.MINIMAL.
// Gemini 3.5 Flash does not accept thinkingBudget=0 — thinkingLevel is required.
const EMPLOYEE_THINKING_OFF = { thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL } };

// Returns the per-call thinkingConfig for the Supervisor model.
// Read at call time (not module load) so GEMINI_SUPERVISOR_MODEL env-var changes
// on warm Cloud Run instances take effect without restart.
// Flags must be read per call, not in closure.
function getSupervisorThinkingConfig(): { thinkingConfig: { thinkingLevel: ThinkingLevel } | { thinkingBudget: number } } {
  const modelName = process.env.GEMINI_SUPERVISOR_MODEL ?? "gemini-3.1-pro-preview";
  const isGemini3 = modelName.startsWith("gemini-3");
  return isGemini3
    ? { thinkingConfig: { thinkingLevel: budgetToLevel(SUPERVISOR_THINKING_BUDGET) } }
    : { thinkingConfig: { thinkingBudget: SUPERVISOR_THINKING_BUDGET } };
}

type TextPart = { text: string };
type InlinePart = { inlineData: { mimeType: string; data: string } };
type MsgPart = TextPart | InlinePart;
type Content = { role: "user" | "model"; parts: MsgPart[] };
type ChatOptions = { systemInstruction?: string; history?: Content[] };
type ChatInstance = {
  sendMessage: (parts: MsgPart[]) => Promise<{ response: GenerateContentResponse }>;
  sendMessageStream: (parts: MsgPart[]) => Promise<{ stream: AsyncGenerator<GenerateContentResponse> }>;
};

function buildChatShim(ai: GoogleGenAI, modelName: string, baseConfig: GenerateContentConfig, opts: ChatOptions): ChatInstance {
  const history: Content[] = [...(opts.history ?? [])];
  const buildConfig = () => ({
    ...baseConfig,
    ...(opts.systemInstruction ? { systemInstruction: opts.systemInstruction as never } : {}),
  });
  return {
    sendMessage: async (parts: MsgPart[]) => {
      history.push({ role: "user", parts });
      const res = await ai.models.generateContent({
        model: modelName, contents: history as never,
        config: buildConfig(),
      });
      logGeminiUsage(modelName, res);
      history.push({ role: "model", parts: [{ text: res.text ?? res.candidates?.[0]?.content?.parts?.[0]?.text ?? "" }] });
      return { response: res };
    },
    sendMessageStream: async (parts: MsgPart[]) => {
      history.push({ role: "user", parts });
      const stream = await ai.models.generateContentStream({
        model: modelName, contents: history as never,
        config: buildConfig(),
      });
      // Collect chunks into a replayable async generator; append model turn after iteration.
      async function* collectAndAppend(): AsyncGenerator<GenerateContentResponse> {
        let modelText = "";
        for await (const chunk of stream) {
          modelText += chunk.text ?? chunk.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
          yield chunk;
        }
        history.push({ role: "model", parts: [{ text: modelText }] });
      }
      return { stream: collectAndAppend() };
    },
  };
}

type GenerateRequest = { systemInstruction?: unknown; contents?: unknown; generationConfig?: Partial<GenerateContentConfig> };
type ModelWrapper = {
  startChat: (opts: ChatOptions) => ChatInstance;
  generateContent: (req: GenerateRequest | string) => Promise<{ response: GenerateContentResponse }>;
};

function buildModelWrapper(ai: GoogleGenAI, modelName: string, baseConfig: GenerateContentConfig): ModelWrapper {
  return {
    startChat: (opts) => buildChatShim(ai, modelName, baseConfig, opts),
    generateContent: async (request) => {
      if (typeof request === "string") {
        const res = await ai.models.generateContent({ model: modelName, contents: [{ role: "user", parts: [{ text: request }] }], config: baseConfig });
        logGeminiUsage(modelName, res);
        return { response: res };
      }
      const genConfigOverrides = (request as { generationConfig?: GenerateContentConfig }).generationConfig ?? {};
      const config: GenerateContentConfig = { ...baseConfig, ...genConfigOverrides, ...(request.systemInstruction ? { systemInstruction: request.systemInstruction as never } : {}) };
      const res = await ai.models.generateContent({ model: modelName, contents: (request.contents ?? []) as never, config });
      logGeminiUsage(modelName, res);
      return { response: res };
    },
  };
}

export function getGeminiModel(): ModelWrapper {
  return buildModelWrapper(getAiCompanion(), MODEL, { temperature: 0, maxOutputTokens: 1500, responseMimeType: "application/json", responseSchema: EMPLOYEE_RESPONSE_SCHEMA as never, safetySettings: SAFETY_SETTINGS, ...EMPLOYEE_THINKING_OFF });
}
export function getGeminiTextModel(): ModelWrapper {
  return buildModelWrapper(getAiCompanion(), MODEL, { temperature: 0, maxOutputTokens: 200, safetySettings: SAFETY_SETTINGS, ...EMPLOYEE_THINKING_OFF });
}
export function getGeminiModelForParseSale(): ModelWrapper {
  return buildModelWrapper(getAiCompanion(), MODEL, { temperature: 0, maxOutputTokens: 400, responseMimeType: "application/json", safetySettings: SAFETY_SETTINGS, ...EMPLOYEE_THINKING_OFF });
}
export function getGeminiSupervisorModel(): ModelWrapper {
  return buildModelWrapper(getAiSupervisor(), SUPERVISOR_MODEL, { temperature: 0, maxOutputTokens: SUPERVISOR_MAX_OUTPUT_TOKENS, responseMimeType: "application/json", responseSchema: SUPERVISOR_RESPONSE_SCHEMA as never, safetySettings: SAFETY_SETTINGS, ...getSupervisorThinkingConfig() });
}

// COST-N-1: minimal-thinking variant for simple intents (stock lookup, balance, etc.).
// ThinkingLevel.MINIMAL disables extended thinking — saves ~2048 thinking tokens per call.
// Same schema/settings as the standard model; only thinking level differs.
export function getGeminiSupervisorModelMinimal(): ModelWrapper {
  const modelName = process.env.GEMINI_SUPERVISOR_MODEL ?? "gemini-3.1-pro-preview";
  const isGemini3 = modelName.startsWith("gemini-3");
  const minimalThinking = isGemini3
    ? { thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL } }
    : { thinkingConfig: { thinkingBudget: 0 } };
  return buildModelWrapper(getAiSupervisor(), SUPERVISOR_MODEL, { temperature: 0, maxOutputTokens: SUPERVISOR_MAX_OUTPUT_TOKENS, responseMimeType: "application/json", responseSchema: SUPERVISOR_RESPONSE_SCHEMA as never, safetySettings: SAFETY_SETTINGS, ...minimalThinking });
}
