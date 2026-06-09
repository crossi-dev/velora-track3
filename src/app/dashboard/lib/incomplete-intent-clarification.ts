// Detecta inputs que son un verbo-de-acción aislado, sin información para
// completar la intención (ej. "vendí" solo, sin producto ni cantidad).
//
// Sin esto el comando cae como `no-match` y va al fallback de IA. La IA
// puede o no responder con una pregunta útil. Para los casos conocidos
// donde sabemos exactamente qué falta, respondemos client-side: más rápido
// (sin roundtrip), determinístico, y con un ejemplo concreto que enseña
// el formato esperado.

import { tLang } from "./DashboardLangContext";
import { normalizeForMatching } from "../../api/business-assistant/_lib/shared";

export interface IncompleteIntentClarification {
  /** Mensaje que el chat muestra al usuario. */
  message: string;
}

// Verbos de venta que exigen al menos un producto + cantidad. Mismo set
// que SALE_VERBS_RE en command-parsers/register-sale.ts pero anclado a
// inicio/fin de línea (con un punto opcional al final por dictado STT
// que termina la frase con periodo).
const SALE_VERB_ALONE_RE =
  /^(?:vendi|vendele|vendeme|vendo|factura(?:le|me)?|anota(?:le|me)?|registra(?:le|me)?)\s*\.?\s*$/;

export function detectIncompleteIntent(
  rawText: unknown,
): IncompleteIntentClarification | null {
  if (typeof rawText !== "string") return null;
  const trimmed = rawText.trim();
  if (!trimmed) return null;
  const normalized = normalizeForMatching(trimmed);
  if (!normalized) return null;

  if (SALE_VERB_ALONE_RE.test(normalized)) {
    return {
      message: tLang(
        'What did you sell? Tell me the product and quantity. For example: "I sold 2 cokes at 1500".',
        '¿Qué vendiste? Decime el producto y la cantidad. Por ejemplo: "vendí 2 cocas a 1500".',
      ),
    };
  }

  return null;
}
