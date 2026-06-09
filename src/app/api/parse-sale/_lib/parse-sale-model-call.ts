import { getGeminiModelForParseSale } from "@/app/api/business-assistant/_lib/gemini-client";
import { callGemini } from "@/app/api/business-assistant/_lib/gemini-wrapper";
import type { RawSaleEntry } from "./parse-sale-types";

const SYSTEM_PROMPT =
  'Sos un parser de ventas. Dada una descripción en lenguaje natural de una o más ventas, extraé un ARRAY JSON donde cada elemento tenga { customerName: string, items: [{ productName: string, quantity: number, unitPrice?: number }] }. Si el mensaje describe varias ventas a distintos clientes, devolvé un objeto por cliente. Si es una sola venta a un cliente con varios productos, devolvé un único objeto con varios ítems. Si la cantidad significa "todo", "toda", "todos", "todas" o cualquier expresión que implique todo el stock disponible, usá -1 como cantidad. Convertí números escritos a dígitos: un/una=1, dos=2, tres=3, cuatro=4, cinco=5, seis=6, siete=7, ocho=8, nueve=9, diez=10, once=11, doce=12, quince=15, veinte=20, treinta=30, cincuenta=50, cien=100. Si el usuario menciona un precio por unidad, incluilo en unitPrice. Devolvé SOLO un array JSON válido, sin markdown y sin explicación.';

// Budget: 5s per attempt, 1.5s backoff, 1 retry → 11.5s max (within maxDuration=15)
const ATTEMPT_TIMEOUT_MS = 5_000;
const RETRY_BACKOFF_MS = 1_500;
const MAX_ATTEMPTS = 2;

export type ParseSaleModelResult =
  | { ok: true; rawSales: RawSaleEntry[] }
  | { ok: false; kind: "empty_response" | "invalid_json" };

const isRetriable = (err: unknown) => {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    err.name === "AbortError" ||
    msg.includes("network") ||
    msg.includes("fetch") ||
    msg.includes("econnreset") ||
    msg.includes("503") ||
    msg.includes("529")
  );
};

export async function callParseSaleModel(inputText: string): Promise<ParseSaleModelResult> {
  const geminiCall = async (): Promise<string> => {
    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const model = getGeminiModelForParseSale();
        const timeout = new Promise<never>((_, reject) =>
          setTimeout(() => reject(Object.assign(new Error("Gemini call timed out"), { name: "TimeoutError" })), ATTEMPT_TIMEOUT_MS)
        );
        const result = await Promise.race([
          model.generateContent({
            systemInstruction: SYSTEM_PROMPT,
            contents: [{ role: "user", parts: [{ text: inputText }] }],
          }),
          timeout,
        ]);
        return result.response.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
      } catch (err) {
        lastError = err;
        if (!isRetriable(err) || attempt === MAX_ATTEMPTS) throw err;
        await new Promise((resolve) => setTimeout(resolve, RETRY_BACKOFF_MS));
      }
    }
    throw lastError;
  };

  const { text: responseText } = await callGemini(geminiCall);

  if (!responseText) {
    return { ok: false, kind: "empty_response" };
  }

  const cleanText = responseText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();

  let rawSales: RawSaleEntry[];
  try {
    const raw = JSON.parse(cleanText);
    rawSales = Array.isArray(raw) ? (raw as RawSaleEntry[]) : [raw as RawSaleEntry];
  } catch {
    return { ok: false, kind: "invalid_json" };
  }

  return { ok: true, rawSales };
}
