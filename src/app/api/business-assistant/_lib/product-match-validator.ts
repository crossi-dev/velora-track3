// Defensa determinística contra alucinaciones de producto del LLM.
//
// Caso de fuga: el dueño tiene en catálogo "cubiertas usadas" y "cubiertas
// nuevas". El cajero dice "vendí dos cubiertas usadas". El LLM, mal
// templateado o con noise, devuelve `productName: "cubiertas nuevas"`. El
// matcher de catálogo encuentra "cubiertas nuevas" exacto y ejecuta la
// venta del producto equivocado. El stock del producto correcto no baja,
// el del incorrecto sí. Daño: silent-data-corruption + cliente paga
// precio del catálogo equivocado.
//
// Solución: cruzá el nombre matcheado contra el texto que escribió el
// usuario. Si el productName matcheado tiene tokens "qualifiers"
// (palabras que distinguen variantes) que NO aparecen en el texto del
// usuario, la match es sospechosa.
//
// Este módulo es PURO — sin DB, sin LLM, solo string analysis. Diseñado
// para correr en hot path (post-model dispatch) sin agregar latencia.
//
// Política:
//   - Si todos los tokens del matched name aparecen (normalizados, case-
//     insensitive, accent-stripped) en el texto del usuario → "ok".
//   - Si algún qualifier token no aparece → "discriminator_missing" +
//     lista de tokens faltantes. El caller decide si:
//       a) loguear warning (modo soft, no bloquea venta)
//       b) forzar clarification (modo hard, próximo paso)
//
// NO forzamos clarification en este commit — primero medimos cuánto pasa
// en tráfico real. Si nunca pasa = matcher es fuerte. Si pasa
// con frecuencia = endurecemos a hard-block en próxima iter.

import { normalizeForMatching } from "./shared";
import { GRAMMATICAL_STOPWORDS_ES } from "../../../../lib/stopwords";

export type ProductMatchValidation =
  | { kind: "ok" }
  | { kind: "empty" }
  | { kind: "discriminator_missing"; missing: string[] };

// Grammatical stop-tokens that do not contribute to product discrimination.
// Canonical source: src/lib/stopwords.ts — GRAMMATICAL_STOPWORDS_ES.
// We intentionally keep ONLY grammatical words here (not domain verbs or
// query words) so the validator stays conservative: preferring false
// positives (extra logging) over false negatives (alucinación que pasa).
const STOP_TOKENS = GRAMMATICAL_STOPWORDS_ES;

function tokenize(value: string): string[] {
  const normalized = normalizeForMatching(value);
  if (!normalized) return [];
  return normalized
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

/**
 * Valida que todos los tokens significativos del producto matcheado
 * aparezcan en el texto del usuario. Retorna `discriminator_missing`
 * con los tokens que no aparecen, o `ok` si match es defendible.
 */
export function validateProductMatch(
  matchedProductName: string,
  userText: string,
): ProductMatchValidation {
  const matchedTokens = tokenize(matchedProductName).filter((t) => !STOP_TOKENS.has(t));
  if (matchedTokens.length === 0) return { kind: "empty" };

  const userTokens = new Set(tokenize(userText));
  if (userTokens.size === 0) return { kind: "empty" };

  const missing: string[] = [];
  for (const token of matchedTokens) {
    // Considera presente si el token completo o un prefijo ≥3 chars del token
    // matchea algo en el texto del usuario. Esto cubre plurales informales
    // ("cubierta" ↔ "cubiertas") sin requerir lemmatización.
    let found = false;
    for (const userTok of userTokens) {
      if (userTok === token) {
        found = true;
        break;
      }
      // Prefijo común ≥3 chars (cubre singular/plural y diminutivos rioplatenses).
      // If the first minLen chars of both tokens match they are variants of the
      // same word (e.g. "cubierta" / "cubiertas").
      const minLen = Math.min(token.length, userTok.length);
      if (minLen >= 3 && token.slice(0, minLen) === userTok.slice(0, minLen)) {
        found = true;
        break;
      }
    }
    if (!found) missing.push(token);
  }

  if (missing.length === 0) return { kind: "ok" };
  return { kind: "discriminator_missing", missing };
}
