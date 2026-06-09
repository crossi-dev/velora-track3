import "server-only";
// extract-shipping-entities.ts
//
// Gemini-based Named Entity Recognition for shipping context.
// Extracts customerName, address, postalCode, and city from a free-text owner message
// using Gemini structured output (responseSchema + application/json).
//
// Design principles:
// - Uses GeminiModels.NER (gemini-2.5-flash-lite) — fastest/cheapest tier, ideal for
//   deterministic 4-field structured extraction with max 150 output tokens.
//   Source: https://ai.google.dev/gemini-api/docs/models ("fastest and most budget-friendly")
// - Returns null on any error so the caller falls back to the existing regex path.
// - Temperature 0, thinking disabled — deterministic extraction, not generative.
// - Max 150 output tokens — 4 short strings, no chain-of-thought.
// - Location: NER_LOCATION (default us-central1). Flash-Lite is NOT available in
//   southamerica-east1 (404s confirmed 2026-05-29) — mirrors CLASSIFIER_LOCATION pattern.
//
// Source: https://cloud.google.com/vertex-ai/generative-ai/docs/multimodal/control-generated-output
// (confirmed HTTP 200: responseMimeType="application/json" + responseSchema with Type enums)
//
// Reuses buildGenAI pattern from gemini-client.ts (same constructor, different location).
// Does NOT use getGeminiModel() because those wrappers hard-code Companion schema/config.

import { GoogleGenAI, Type, HarmCategory, HarmBlockThreshold } from "@google/genai";
import { GeminiModels } from "@/lib/gemini-models";
import { cloudLog } from "@/lib/cloud-logger";

export interface ShippingEntities {
  customerName: string | null;
  address: string | null;
  postalCode: string | null;
  city: string | null;
}

// Response schema for Gemini structured output.
// Type enum from @google/genai — same pattern as EMPLOYEE_RESPONSE_SCHEMA in gemini-schemas.ts.
// nullable: true is required for optional fields in the Vertex AI schema spec.
const SHIPPING_ENTITIES_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    customerName: { type: Type.STRING, nullable: true },
    address:      { type: Type.STRING, nullable: true },
    postalCode:   { type: Type.STRING, nullable: true },
    city:         { type: Type.STRING, nullable: true },
  },
} as const;

// Safety settings — mirrors SAFETY_SETTINGS in gemini-client.ts.
const SAFETY_SETTINGS = [
  { category: HarmCategory.HARM_CATEGORY_HARASSMENT,        threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
  { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,       threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
  { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
  { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
];

// Module-level singleton — same pattern as _aiCompanion / _aiSupervisor in gemini-client.ts.
// Flash-Lite (gemini-2.5-flash-lite) is NOT available in southamerica-east1 (404s);
// use NER_LOCATION (default us-central1) — mirrors the CLASSIFIER_LOCATION pattern.
// Override: NER_LOCATION env var.
const NER_LOCATION =
  process.env.NER_LOCATION ??
  process.env.CLASSIFIER_LOCATION ??
  "us-central1";

let _aiNer: GoogleGenAI | null = null;

function getAiNer(): GoogleGenAI {
  if (!_aiNer) {
    const projectId = process.env.GOOGLE_CLOUD_PROJECT ?? "my-gcp-project";
    const opts: ConstructorParameters<typeof GoogleGenAI>[0] = {
      vertexai: true,
      project:  projectId,
      location: NER_LOCATION,
    };
    const credentialsJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
    if (credentialsJson) {
      let credentials: Record<string, unknown>;
      try { credentials = JSON.parse(credentialsJson) as Record<string, unknown>; }
      catch { throw new Error("GOOGLE_APPLICATION_CREDENTIALS_JSON is not valid JSON"); }
      opts.googleAuthOptions = { credentials };
    }
    _aiNer = new GoogleGenAI(opts);
  }
  return _aiNer;
}

const SYSTEM_INSTRUCTION = `Sos un extractor de entidades de envío. Dado un mensaje en español de un dueño de negocio argentino, extraé las siguientes entidades si están presentes:
- customerName: nombre del cliente destinatario (una o más palabras con mayúscula inicial, SIN incluir verbos ni artículos como "a", "para", "de")
- address: dirección de calle del destino (calle + número, ej. "Corrientes 1234")
- postalCode: código postal numérico de 4 o 5 dígitos (ej. "5500")
- city: nombre de la ciudad o localidad (ej. "Mendoza", "Buenos Aires")

Si una entidad no está presente en el mensaje, devolvé null para ese campo. Devolvé SOLO el JSON con los 4 campos, sin texto adicional.`;

/**
 * Extracts shipping-relevant entities from a free-text owner message using
 * Gemini structured output. Returns null if Gemini fails or no entities found.
 *
 * The caller MUST treat null as "fall back to existing regex path" — this function
 * never throws.
 *
 * @param text - Raw owner message (e.g. "vendele 1 alfajor a Juan Corrientes 1234 Buenos Aires 1043")
 */
export async function extractShippingEntities(
  text: string,
): Promise<ShippingEntities | null> {
  if (!text || text.trim().length < 3) return null;

  const modelName = GeminiModels.NER;

  try {
    const ai = getAiNer();
    const response = await ai.models.generateContent({
      model:    modelName,
      contents: [{ role: "user", parts: [{ text }] }],
      config: {
        systemInstruction:  SYSTEM_INSTRUCTION,
        temperature:        0,
        maxOutputTokens:    150,
        responseMimeType:   "application/json",
        responseSchema:     SHIPPING_ENTITIES_SCHEMA as never,
        safetySettings:     SAFETY_SETTINGS,
        // Thinking disabled — deterministic extraction, not generative reasoning.
        // gemini-2.5-x uses thinkingBudget (numeric); thinkingLevel 400s on 2.5 models.
        // See gemini-client.ts lines 86-96 for the full per-generation explanation.
        thinkingConfig:     { thinkingBudget: 0 },
      },
    });

    const raw = response.text ?? response.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    if (!raw) {
      cloudLog({
        severity:    "WARNING",
        component:   "Supervisor",
        action:      "EXTRACT_SHIPPING_ENTITIES_EMPTY",
        a2a_transfer: false,
        message:     "extractShippingEntities: Gemini returned empty response",
        data:        { model: modelName, inputLength: text.length },
      });
      return null;
    }

    // Gemini structured output returns JSON directly (no prose wrapping).
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      cloudLog({
        severity:    "WARNING",
        component:   "Supervisor",
        action:      "EXTRACT_SHIPPING_ENTITIES_PARSE_FAIL",
        a2a_transfer: false,
        message:     "extractShippingEntities: could not parse Gemini JSON response",
        data:        { model: modelName, raw: raw.slice(0, 200) },
      });
      return null;
    }

    const entities: ShippingEntities = {
      customerName: typeof parsed.customerName === "string" && parsed.customerName.trim() ? parsed.customerName.trim() : null,
      address:      typeof parsed.address      === "string" && parsed.address.trim()      ? parsed.address.trim()      : null,
      postalCode:   typeof parsed.postalCode   === "string" && /^\d{4,5}$/.test(parsed.postalCode.trim()) ? parsed.postalCode.trim() : null,
      city:         typeof parsed.city         === "string" && parsed.city.trim()         ? parsed.city.trim()         : null,
    };

    // Return null if no entity was extracted (all null → nothing useful).
    const hasAny = Object.values(entities).some((v) => v !== null);
    if (!hasAny) return null;

    cloudLog({
      severity:    "INFO",
      component:   "Supervisor",
      action:      "EXTRACT_SHIPPING_ENTITIES_OK",
      a2a_transfer: false,
      message:     "extractShippingEntities: extracted shipping entities",
      data:        { model: modelName, entities },
    });

    return entities;
  } catch (err) {
    cloudLog({
      severity:    "WARNING",
      component:   "Supervisor",
      action:      "EXTRACT_SHIPPING_ENTITIES_ERROR",
      a2a_transfer: false,
      message:     "extractShippingEntities: Gemini call failed — falling back to regex",
      data:        { model: modelName, error: err instanceof Error ? err.message : String(err) },
    });
    return null;
  }
}
