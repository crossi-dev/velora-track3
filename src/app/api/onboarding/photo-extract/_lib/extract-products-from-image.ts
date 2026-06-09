// Calls Gemini Pro Vision with a notebook/label image and returns the parsed
// product list. Reuses GoogleGenAI client pattern from gemini-client.ts.
// Argentina-tuned: prices in ARS, no line-level VAT, no CUIT.

import { GoogleGenAI, Type } from "@google/genai";
import { SAFETY_SETTINGS } from "@/app/api/business-assistant/_lib/gemini-client";
import { GeminiModels } from "@/lib/gemini-models";

const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT ?? "my-gcp-project";
// Photo extraction uses Gemini Pro (visual reasoning over notebook/label photos).
// Pro is NOT available in southamerica-east1 (verified 2026-05-10). Default to
// us-south1 to match the supervisor region in gemini-client.ts.
const LOCATION = process.env.VERTEX_LOCATION_SUPERVISOR ?? "us-south1";

const PRODUCT_LIST_SCHEMA = {
  type: Type.OBJECT,
  required: ["products"],
  properties: {
    products: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        required: ["name"],
        properties: {
          name: { type: Type.STRING },
          price: { type: Type.NUMBER },
          stock: { type: Type.NUMBER },
        },
      },
    },
  },
};

const PROMPT = `Analizá la foto del cuaderno o etiquetas de un negocio argentino y extraé el listado de productos.

REGLAS:
- Devolvé un JSON con la forma { "products": [{ "name": string, "price": number | null, "stock": number | null }] }.
- Los precios están en pesos argentinos (ARS). Convertí "15.000", "15000", "$15.000", "15 lucas" todos a 15000.
- Si una línea no tiene precio, dejá price en null. Mismo criterio para stock.
- Ignorá totales, subtotales, fechas, encabezados y notas que no sean items.
- El name tiene que ser corto y comercial (ej: "alimento perro adulto 3kg", no "ALIMENTO PERRO ADULTO TRES KILOS DOG CHOW").
- No inventes productos: si la foto está borrosa o vacía, devolvé { "products": [] }.
- No agregues IVA ni descomposición fiscal — Velora maneja Monotributistas argentinos.`;

let _aiImageExtract: GoogleGenAI | null = null;

function getAiImageExtract(): GoogleGenAI {
  if (!_aiImageExtract) {
    const credentialsJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
    const opts: ConstructorParameters<typeof GoogleGenAI>[0] = { vertexai: true, project: PROJECT_ID, location: LOCATION };
    if (credentialsJson) {
      opts.googleAuthOptions = { credentials: JSON.parse(credentialsJson) as Record<string, unknown> };
    }
    _aiImageExtract = new GoogleGenAI(opts);
  }
  return _aiImageExtract;
}

export interface ExtractedProduct {
  name: string;
  price: number | null;
  stock: number | null;
}

export interface ExtractedProductList {
  products: ExtractedProduct[];
}

function sanitizeProduct(raw: unknown): ExtractedProduct | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const name = typeof obj.name === "string" ? obj.name.trim().slice(0, 120) : "";
  if (!name) return null;
  const price = typeof obj.price === "number" && Number.isFinite(obj.price) && obj.price >= 0 ? obj.price : null;
  const stock = typeof obj.stock === "number" && Number.isFinite(obj.stock) && obj.stock >= 0 ? Math.round(obj.stock) : null;
  return { name, price, stock };
}

export async function extractProductsFromImage(
  imageBytes: ArrayBuffer,
  mimeType: string,
): Promise<ExtractedProductList> {
  const base64 = Buffer.from(imageBytes).toString("base64");

  const res = await getAiImageExtract().models.generateContent({
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
      maxOutputTokens: 2000,
      responseMimeType: "application/json",
      responseSchema: PRODUCT_LIST_SCHEMA as never,
      safetySettings: SAFETY_SETTINGS,
    } as never,
  });

  const parts = res.candidates?.[0]?.content?.parts ?? [];
  const raw = parts.map(p => p.text).filter((t): t is string => typeof t === "string" && t.length > 0).at(-1) ?? "";
  if (!raw) return { products: [] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { products: [] };
  }
  if (!parsed || typeof parsed !== "object") return { products: [] };
  const list = (parsed as { products?: unknown }).products;
  if (!Array.isArray(list)) return { products: [] };
  const products = list.map(sanitizeProduct).filter((p): p is ExtractedProduct => p !== null).slice(0, 50);
  return { products };
}
