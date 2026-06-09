import { z } from "zod";
import { getGeminiModel } from "@/app/api/business-assistant/_lib/gemini-client";
import { callGemini } from "@/app/api/business-assistant/_lib/gemini-wrapper";
import { cloudLog } from "@/lib/cloud-logger";

// LLM02 (insecure output handling): the model's JSON is parsed into business
// state (products, customers). Validate strictly with Zod and cap arrays so a
// prompt-injected response can't seed thousands of rows or oversize strings.
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const MAX_PRODUCTS = 200;
const MAX_CUSTOMERS = 200;

const ParsedOnboardingDataSchema = z.object({
  businessName: z.string().trim().min(1).max(120),
  businessType: z.enum(["retail", "hardware", "food", "services", "auto", "other"]),
  openingTime: z.union([z.string().regex(HHMM_RE), z.null()]).default(null),
  closingTime: z.union([z.string().regex(HHMM_RE), z.null()]).default(null),
  // FIX 2: currency collected in chat; optional here so old callers don't break
  currency: z.string().trim().max(10).optional(),
  // FIX 1: fiscal/contact/payment fields — optional, null when not provided
  cuit: z.union([z.string().trim().max(20), z.null()]).optional(),
  address: z.union([z.string().trim().max(255), z.null()]).optional(),
  phone: z.union([z.string().trim().max(40), z.null()]).optional(),
  alias: z.union([z.string().trim().max(100), z.null()]).optional(),
  products: z
    .array(z.object({
      name: z.string().trim().min(1).max(120),
      price: z.union([z.number().finite().min(0).max(1e9), z.null()]).default(null),
      stock: z.union([z.number().int().min(0).max(1e6), z.null()]).default(null),
    }))
    .max(MAX_PRODUCTS)
    .default([]),
  customers: z
    .array(z.object({
      name: z.string().trim().min(1).max(120),
      phone: z.union([z.string().trim().max(40), z.null()]).default(null),
    }))
    .max(MAX_CUSTOMERS)
    .default([]),
});

export type ParsedOnboardingData = z.infer<typeof ParsedOnboardingDataSchema>;

const SYSTEM_PROMPT = `Sos un extractor de datos para configurar un negocio. Dado un texto en español, extraé un JSON con esta estructura exacta:
{
  "businessName": string,
  "businessType": "retail" | "hardware" | "food" | "services" | "auto" | "other",
  "openingTime": "HH:MM" | null,
  "closingTime": "HH:MM" | null,
  "products": [{ "name": string, "price": number | null, "stock": number | null }],
  "customers": [{ "name": string, "phone": string | null }]
}
Reglas:
- businessName: nombre del negocio si se menciona, o inferilo del contexto
- businessType: inferí del tipo de productos o descripción. Ejemplos: herramientas/materiales→hardware, verdulería/panadería→food, ropa/boutique/franquicia retail→retail, taller→auto
- products: productos mencionados con precio si se indica
- customers: clientes mencionados con teléfono si se indica
- Devolvé SOLO el JSON válido, sin markdown.`;

function parseJson(raw: string): ParsedOnboardingData {
  const clean = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(clean);
  } catch (err) {
    cloudLog({
      severity: "WARNING",
      component: "System",
      action: "ONBOARDING_PARSE_JSON_FAILED",
      a2a_transfer: false,
      message: "onboarding orchestrator JSON.parse failed on Gemini output",
      data: { rawPreview: clean.slice(0, 300), error: err instanceof Error ? err.message : String(err) },
    });
    throw new Error("ONBOARDING_PARSE_FAILED");
  }
  const validated = ParsedOnboardingDataSchema.safeParse(parsed);
  if (!validated.success) {
    cloudLog({
      severity: "WARNING",
      component: "System",
      action: "ONBOARDING_ZOD_VALIDATION_FAILED",
      a2a_transfer: false,
      message: "onboarding orchestrator output failed Zod validation",
      data: { rawPreview: clean.slice(0, 300), zodError: validated.error.flatten() },
    });
    throw new Error("ONBOARDING_VALIDATION_FAILED");
  }
  return validated.data;
}

const GEMINI_TIMEOUT_MS = 30_000;

async function parseWithGemini(text: string): Promise<string> {
  const model = getGeminiModel();
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(Object.assign(new Error("Gemini timeout"), { name: "TimeoutError" })), GEMINI_TIMEOUT_MS),
  );
  const result = await Promise.race([
    model.generateContent({
      systemInstruction: SYSTEM_PROMPT,
      contents: [{ role: "user", parts: [{ text }] }],
    }),
    timeout,
  ]);
  return result.response.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
}

export async function parseOnboardingDescription(text: string): Promise<ParsedOnboardingData> {
  const { text: raw } = await callGemini(() => parseWithGemini(text));
  return parseJson(raw);
}
