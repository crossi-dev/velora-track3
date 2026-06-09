import { z } from "zod";
import { GoogleGenAI, Type, HarmCategory, HarmBlockThreshold } from "@google/genai";
import mammoth from "mammoth";
import { cloudLog } from "@/lib/cloud-logger";
import { SAFETY_SETTINGS } from "@/app/api/business-assistant/_lib/gemini-client";
import { GeminiModels } from "@/lib/gemini-models";

// ── Public types ──────────────────────────────────────────────────────────────

export interface ExtractedRule {
  kind: "time-based" | "condition-based" | "behavior-based";
  trigger: string;
  message: string;
  cron?: string | null;
}

export interface ExtractRulesResult {
  rules: ExtractedRule[];
  truncated: boolean;
}

// Inline content part type — replaces the removed `Part` import from vertexai.
type ContentPart = { text: string } | { inlineData: { mimeType: string; data: string } };

// ── Zod schema ────────────────────────────────────────────────────────────────

const ExtractedRuleSchema = z.object({
  kind: z.enum(["time-based", "condition-based", "behavior-based"]),
  trigger: z.string().min(1),
  message: z.string().min(1),
  cron: z.string().nullable().optional(),
});

const ExtractionResponseSchema = z.object({
  rules: z.array(ExtractedRuleSchema),
});

// ── Vertex AI JSON response schema ────────────────────────────────────────────

const EXTRACTION_RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  required: ["rules"],
  properties: {
    rules: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        required: ["kind", "trigger", "message"],
        properties: {
          kind: {
            type: Type.STRING,
            enum: ["time-based", "condition-based", "behavior-based"],
          },
          trigger: { type: Type.STRING },
          message: { type: Type.STRING },
          cron: { type: Type.STRING },
        },
      },
    },
  },
};

// ── Vertex client factory ─────────────────────────────────────────────────────

// Gemini 3.1 Pro is not available in southamerica-east1. Pro requires us-south1.
function getAiExtract(): GoogleGenAI {
  const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT ?? "my-gcp-project";
  const location =
    process.env.VERTEX_LOCATION_RULE_EXTRACT ??
    process.env.VERTEX_LOCATION_SUPERVISOR ??
    process.env.GOOGLE_CLOUD_LOCATION ??
    "us-south1";
  const credentialsJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  const opts: ConstructorParameters<typeof GoogleGenAI>[0] = { vertexai: true, project: PROJECT_ID, location };
  if (credentialsJson) {
    opts.googleAuthOptions = { credentials: JSON.parse(credentialsJson) as Record<string, unknown> };
  }
  return new GoogleGenAI(opts);
}

// ── Extraction prompt ─────────────────────────────────────────────────────────

const EXTRACTION_PROMPT = `Sos un extractor de reglas operativas para un sistema de gestión de negocio.

Tu tarea: leer COMPLETAMENTE el documento y extraer CADA directiva operativa como una regla.

Para cada regla determiná su tipo según ESTAS TRES OPCIONES EXACTAS:

1. Tiene horario fijo explícito (ej: "a las 9hs", "todos los lunes a las 20hs", "cada día a las 14:30"):
   - kind: "time-based"
   - trigger: descripción corta libre (snake_case, máx 60 chars), ej: "apertura_diaria"
   - message: instrucción clara y cálida para el empleado en vos argentino
   - cron: OBLIGATORIO — expresión de 5 campos en hora Argentina (ART = UTC-3, sin DST).
     Formato: "MIN HORA * * DÍASEM" donde DÍASEM 0=domingo…6=sábado.
     Ejemplos: "0 9 * * 1-5" = lun-vie 9am · "0 20 * * *" = todos los días 20hs · "0 8 * * 1" = lunes 8am.
     Si no podés determinar la hora exacta, usá el momento más representativo del contexto.
     Sin cron la regla no puede ejecutarse — es REQUERIDO para time-based.

2. Tiene condición de stock (SOLO umbrales de inventario: "si el stock baja de N", "cuando queden menos de N unidades de X"):
   - kind: "condition-based"
   - trigger: DEBE ser exactamente "stock_below:NOMBRE_PRODUCTO:N"
     donde NOMBRE_PRODUCTO es el nombre del producto mencionado textualmente y N es el número umbral entero.
     Ejemplo: "stock_below:galletitas:5"  |  "stock_below:agua mineral:10"
     CRÍTICO: si el trigger no tiene este formato exacto, la regla nunca se va a ejecutar.
   - message: instrucción clara y cálida para el empleado en vos argentino
   - cron: null

3. Todo lo demás — conductas, procedimientos, actitud, presentación personal (ej: "saludar al cliente", "usar uniforme"):
   - kind: "behavior-based"
   - trigger: descripción corta libre (snake_case o frase corta, máx 60 chars)
   - message: instrucción clara y cálida para el empleado en vos argentino
   - cron: null

Extraé TODAS las reglas sin excepción. No omitas ninguna directiva aunque parezca obvia.`;

// ── Pure parse helper (exported for unit tests) ───────────────────────────────

/**
 * Parses raw JSON text from a Vertex response into ExtractRulesResult.
 * Pure function — no I/O, safe to unit-test without a live Vertex call.
 */
export function parseExtractionResponse(
  rawText: string,
  finishReason: string | undefined,
): ExtractRulesResult {
  const truncated = finishReason === "MAX_TOKENS";

  const cleaned = rawText
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (jsonErr) {
    cloudLog({
      severity: "WARNING",
      component: "System",
      action: "EXTRACT_RULES_PARSE_FAILED",
      a2a_transfer: false,
      message: "extract-rules: JSON.parse failed on Gemini output",
      data: {
        rawPreview: rawText.slice(0, 300),
        error: jsonErr instanceof Error ? jsonErr.message : String(jsonErr),
      },
    });
    return { rules: [], truncated };
  }

  const validated = ExtractionResponseSchema.safeParse(parsed);
  if (!validated.success) {
    cloudLog({
      severity: "WARNING",
      component: "System",
      action: "EXTRACT_RULES_ZOD_FAILED",
      a2a_transfer: false,
      message: "extract-rules: Zod safeParse failed on Gemini output",
      data: {
        rawPreview: rawText.slice(0, 300),
        zodError: validated.error.flatten(),
      },
    });
    return { rules: [], truncated };
  }

  return { rules: validated.data.rules, truncated };
}

// ── Main extractor ────────────────────────────────────────────────────────────

/**
 * Extracts business rules from a PDF or DOCX buffer using Gemini Pro.
 *
 * PDF: sent as multimodal inlineData — native OCR handles scanned pages.
 * DOCX: text extracted via mammoth, then sent as a text part.
 *
 * Returns the parsed rules and a truncated flag (true when MAX_TOKENS fired).
 * On Vertex error: propagates — the route handler catches it as FILE_PARSE_FAILED.
 */
export async function extractRules(
  buffer: ArrayBuffer,
  filename: string,
): Promise<ExtractRulesResult> {
  const ext = filename.split(".").pop()?.toLowerCase();
  const ai = getAiExtract();

  let contentPart: ContentPart;

  if (ext === "pdf") {
    const base64 = Buffer.from(buffer).toString("base64");
    contentPart = {
      inlineData: { mimeType: "application/pdf", data: base64 },
    };
  } else {
    // DOCX — extract full text with mammoth, no char cap
    const { value: docText } = await mammoth.extractRawText({
      buffer: Buffer.from(buffer),
    });
    contentPart = { text: docText };
  }

  const res = await ai.models.generateContent({
    model: GeminiModels.RULE_EXTRACT,
    contents: [{ role: "user", parts: [{ text: EXTRACTION_PROMPT }, contentPart] }],
    config: {
      temperature: 0,
      maxOutputTokens: 32000,
      responseMimeType: "application/json",
      responseSchema: EXTRACTION_RESPONSE_SCHEMA as never,
      safetySettings: SAFETY_SETTINGS,
      // No thinkingConfig: Gemini 3.1 Pro may always reason; dynamic thinking is fine.
    } as never,
  });

  const candidate = res.candidates?.[0];
  const rawText = (candidate?.content?.parts?.[0]?.text ?? "").trim();
  const finishReason = candidate?.finishReason as string | undefined;

  return parseExtractionResponse(rawText, finishReason);
}
