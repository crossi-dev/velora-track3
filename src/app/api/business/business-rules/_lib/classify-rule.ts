import { z } from "zod";
import { GoogleGenAI, Type, HarmCategory, HarmBlockThreshold } from "@google/genai";
import { cloudLog } from "@/lib/cloud-logger";
import { SAFETY_SETTINGS } from "@/app/api/business-assistant/_lib/gemini-client";
import { GeminiModels } from "@/lib/gemini-models";

export interface RuleClassification {
  kind: "time-based" | "condition-based" | "behavior-based";
  cron: string | null;
  trigger?: string;
}

const FALLBACK: RuleClassification = { kind: "behavior-based", cron: null };

// Zod schema for the model's JSON output. Mirrors the 3-option prompt contract.
const ClassifyResponseSchema = z.object({
  kind: z.enum(["time-based", "condition-based", "behavior-based"]),
  cron: z.string().nullable().optional(),
  trigger: z.string().nullable().optional(),
});

// Vertex AI JSON schema for structured output — forces the model to respect the shape.
const CLASSIFY_RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  required: ["kind"],
  properties: {
    kind: { type: Type.STRING, enum: ["time-based", "condition-based", "behavior-based"] },
    cron: { type: Type.STRING },
    trigger: { type: Type.STRING },
  },
};

// Dedicated GoogleGenAI instance for rule classification — Flash-Lite in companion region.
function getAiClassify(): GoogleGenAI {
  const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT ?? "my-gcp-project";
  const location = process.env.VERTEX_LOCATION_COMPANION ?? "southamerica-east1";
  const credentialsJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  const opts: ConstructorParameters<typeof GoogleGenAI>[0] = { vertexai: true, project: PROJECT_ID, location };
  if (credentialsJson) {
    opts.googleAuthOptions = { credentials: JSON.parse(credentialsJson) as Record<string, unknown> };
  }
  return new GoogleGenAI(opts);
}

// Deterministic fallback — avoids an LLM call when the output is unparseable.
// Detects time patterns (hours, "todos los días", "lunes a viernes", etc.).
function fallbackClassify(message: string): RuleClassification {
  const lower = message.toLowerCase();
  const hasTimePattern =
    /\b\d{1,2}(:\d{2})?\s*(hs|am|pm|h)\b/.test(lower) ||
    /\b(todos los días|lunes a viernes|diariamente|cada día|cada semana)\b/.test(lower) ||
    /\b(mañana|mañanas|tarde|noche|mediodía)\b/.test(lower);
  if (hasTimePattern) return { kind: "time-based", cron: null };
  return FALLBACK;
}

/**
 * Uses Gemini Flash-Lite to classify a rule message as time-based (with cron),
 * condition-based (stock threshold), or behavior-based.
 *
 * Uses structured JSON output (responseMimeType + responseSchema) to force the
 * model to emit valid JSON without markdown fences. Zod safeParse validates the
 * response; if it fails, falls back to deterministic heuristics and logs a
 * WARNING so Flash failures are visible in Cloud Logging.
 *
 * Cron expressions are in Argentina time (ART, UTC-3, no DST).
 */
export async function classifyRule(message: string): Promise<RuleClassification> {
  try {
    const ai = getAiClassify();
    const promptText =
      `Analizá esta instrucción de negocio y determiná su tipo.\n` +
      `Instrucción: "${message}"\n\n` +
      `Respondé con JSON según estas 3 opciones:\n` +
      `- Tiene horario fijo explícito (ej: "a las 20 hs", "9am", "14:30") → ` +
      `{"kind":"time-based","cron":"MIN HORA * * *","trigger":null} con hora Argentina (0-23).\n` +
      `- Tiene condición de stock (ej: "si el stock baja de N", "cuando queden menos de N unidades") → ` +
      `{"kind":"condition-based","cron":null,"trigger":"stock_below:NOMBRE_PRODUCTO:N"} ` +
      `donde NOMBRE_PRODUCTO es el producto mencionado (tal cual) y N es el número umbral.\n` +
      `- Ninguna de las anteriores → {"kind":"behavior-based","cron":null,"trigger":null}`;

    const res = await ai.models.generateContent({
      model: GeminiModels.CLASSIFY,
      contents: [{ role: "user", parts: [{ text: promptText }] }],
      config: {
        temperature: 0,
        maxOutputTokens: 200,
        responseMimeType: "application/json",
        responseSchema: CLASSIFY_RESPONSE_SCHEMA as never,
        safetySettings: SAFETY_SETTINGS,
        thinkingConfig: { thinkingBudget: 0 },
      } as never,
    });

    const raw = (res.text ?? res.candidates?.[0]?.content?.parts?.[0]?.text ?? "").trim();

    // Strip defensive markdown fences in case of older SDK behavior.
    const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();

    let parsed: unknown;
    try {
      parsed = JSON.parse(cleaned);
    } catch (jsonErr) {
      cloudLog({
        severity: "WARNING",
        component: "System",
        action: "CLASSIFY_RULE_JSON_PARSE_FAILED",
        a2a_transfer: false,
        message: "classify-rule: JSON.parse failed on Gemini output — using deterministic fallback",
        data: { rawPreview: raw.slice(0, 300), error: jsonErr instanceof Error ? jsonErr.message : String(jsonErr) },
      });
      return fallbackClassify(message);
    }

    const validated = ClassifyResponseSchema.safeParse(parsed);
    if (!validated.success) {
      cloudLog({
        severity: "WARNING",
        component: "System",
        action: "CLASSIFY_RULE_ZOD_PARSE_FAILED",
        a2a_transfer: false,
        message: "classify-rule: Zod safeParse failed on Gemini output — using deterministic fallback",
        data: {
          rawPreview: raw.slice(0, 300),
          zodError: validated.error.flatten(),
        },
      });
      return fallbackClassify(message);
    }

    const data = validated.data;

    if (data.kind === "condition-based") {
      const trigger = typeof data.trigger === "string" && data.trigger.trim() ? data.trigger.trim() : null;
      if (trigger) return { kind: "condition-based", cron: null, trigger };
      return FALLBACK;
    }

    const cron = typeof data.cron === "string" && data.cron.trim() ? data.cron.trim() : null;
    if (data.kind === "time-based" && !cron) return FALLBACK;
    return { kind: data.kind, cron };
  } catch {
    return FALLBACK;
  }
}
