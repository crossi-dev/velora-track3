// Calls Gemini Pro Vision with a customer-list image and returns the parsed
// customer list. Same tech stack as extract-products-from-image.ts.
// Argentina-tuned: phone numbers in AR format, name as primary key.

import { GoogleGenAI, Type } from "@google/genai";
import { SAFETY_SETTINGS } from "@/app/api/business-assistant/_lib/gemini-client";
import { GeminiModels } from "@/lib/gemini-models";

const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT ?? "my-gcp-project";
const LOCATION = process.env.VERTEX_LOCATION_SUPERVISOR ?? "us-south1";

const CUSTOMER_LIST_SCHEMA = {
  type: Type.OBJECT,
  required: ["customers"],
  properties: {
    customers: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        required: ["name"],
        properties: {
          name: { type: Type.STRING },
          phone: { type: Type.STRING },
        },
      },
    },
  },
};

const PROMPT = `Analizá la foto del cuaderno o lista de clientes de un negocio argentino y extraé el listado de clientes.

REGLAS:
- Devolvé un JSON con la forma { "customers": [{ "name": string, "phone": string | null }] }.
- El campo name es el nombre o apodo del cliente. Mantené el formato original (no capitalices de más).
- El campo phone es el número de teléfono o WhatsApp si aparece junto al nombre. Dejalo en null si no hay.
- Si el teléfono aparece como "11 1234 5678", "011-1234-5678" o "+54 9 11 1234 5678", copialo tal cual — no normalices.
- Ignorá encabezados, totales, fechas, y notas que no sean nombres de clientes.
- No inventes clientes: si la foto está borrosa o vacía, devolvé { "customers": [] }.`;

let _aiCustomerExtract: GoogleGenAI | null = null;

function getAiCustomerExtract(): GoogleGenAI {
  if (!_aiCustomerExtract) {
    const credentialsJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
    const opts: ConstructorParameters<typeof GoogleGenAI>[0] = { vertexai: true, project: PROJECT_ID, location: LOCATION };
    if (credentialsJson) {
      opts.googleAuthOptions = { credentials: JSON.parse(credentialsJson) as Record<string, unknown> };
    }
    _aiCustomerExtract = new GoogleGenAI(opts);
  }
  return _aiCustomerExtract;
}

export interface ExtractedCustomer {
  name: string;
  phone: string | null;
}

export interface ExtractedCustomerList {
  customers: ExtractedCustomer[];
}

function sanitizeCustomer(raw: unknown): ExtractedCustomer | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const name = typeof obj.name === "string" ? obj.name.trim().slice(0, 120) : "";
  if (!name || name.length < 2) return null;
  const phone = typeof obj.phone === "string" && obj.phone.trim() ? obj.phone.trim().slice(0, 30) : null;
  return { name, phone };
}

export async function extractCustomersFromImage(
  imageBytes: ArrayBuffer,
  mimeType: string,
): Promise<ExtractedCustomerList> {
  const base64 = Buffer.from(imageBytes).toString("base64");

  const res = await getAiCustomerExtract().models.generateContent({
    model: GeminiModels.IMAGE_EXTRACT,
    contents: [{
      role: "user",
      parts: [
        { text: PROMPT },
        { inlineData: { mimeType, data: base64 } },
      ],
    }],
    config: {
      temperature: 0,
      maxOutputTokens: 1500,
      responseMimeType: "application/json",
      responseSchema: CUSTOMER_LIST_SCHEMA as never,
      safetySettings: SAFETY_SETTINGS,
    } as never,
  });

  const parts = res.candidates?.[0]?.content?.parts ?? [];
  const raw = parts.map(p => p.text).filter((t): t is string => typeof t === "string" && t.length > 0).at(-1) ?? "";
  if (!raw) return { customers: [] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { customers: [] };
  }
  if (!parsed || typeof parsed !== "object") return { customers: [] };
  const list = (parsed as { customers?: unknown }).customers;
  if (!Array.isArray(list)) return { customers: [] };
  const customers = list.map(sanitizeCustomer).filter((c): c is ExtractedCustomer => c !== null).slice(0, 100);
  return { customers };
}
