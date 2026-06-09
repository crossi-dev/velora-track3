import { normalizeForMatching } from "./shared";
import {
  GRAMMATICAL_STOPWORDS_ES,
  DOMAIN_VERBS_ES,
  DOMAIN_QUERY_WORDS_ES,
  filterStopwords,
} from "../../../../lib/stopwords";

// Deterministic catalog matcher para el branch sale+send. Reemplaza una
// llamada al LLM (4s + variable) por una operación O(catalog) ~5ms con
// scoring estable. El LLM sigue como fallback si esto no resuelve.
//
// Diseño:
// - Tokeniza el texto, descarta stop-words operativas (vendi/manda/wapp/etc)
// - Para cada entrada del catálogo, calcula un score basado en presencia
//   de tokens del nombre en el texto, con tolerancia stem (singular/plural
//   y errores tipográficos cortos)
// - Devuelve match si score ≥30 y el runner-up está al menos 10 puntos
//   abajo. Ambigüedad detectada cuando los dos top tienen scores cercanos.
//
// Por qué no usar findBestCustomerMatch / matchProductByName existentes:
// esperan recibir un nombre ya extraído, no texto crudo. Pasar la frase
// entera produce score=0 porque el algoritmo de overlap necesita que
// "carlos rossi" aparezca como substring del texto.

export interface CatalogEntry {
  id: string;
  name: string;
}

export interface EntityMatch<T extends CatalogEntry> {
  match: T | null;
  ambiguous: boolean;
  candidates?: T[];
}

// Unified sale stop-word set: grammatical + domain verbs + domain queries.
// Canonical source: src/lib/stopwords.ts — do NOT add words here; add to the
// relevant set in that file so all three callers benefit.
const SALE_STOP_WORDS = new Set([
  ...GRAMMATICAL_STOPWORDS_ES,
  ...DOMAIN_VERBS_ES,
  ...DOMAIN_QUERY_WORDS_ES,
]);

function tokensFromText(text: string): string[] {
  return filterStopwords(
    normalizeForMatching(text)
      .split(/\s+/)
      .filter((t) => t.length >= 3),
    [SALE_STOP_WORDS],
  );
}

// Stem-tolerant match: cubre singular/plural ("tuerca" ↔ "tuercas") y
// errores tipográficos cortos ("yerba" ↔ "yerbas"). Requiere prefijo
// común de min(a,b) chars y diferencia de length ≤2.
function stemEqual(a: string, b: string): boolean {
  if (a === b) return true;
  const minLen = Math.min(a.length, b.length);
  if (minLen < 4) return false;
  if (Math.abs(a.length - b.length) > 2) return false;
  return a.slice(0, minLen) === b.slice(0, minLen);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function scoreEntry(textTokens: string[], normalizedText: string, name: string): number {
  const normalizedName = normalizeForMatching(name);
  if (normalizedName.length < 3) return 0;
  // Substring directo con word-boundary: evita falsos positivos como
  // "agua" matcheando "aguardiente". Score máximo cuando el nombre completo
  // aparece como palabra(s) independiente(s) en el texto.
  const wordBoundaryRe = new RegExp(`\\b${escapeRegex(normalizedName)}\\b`);
  if (wordBoundaryRe.test(normalizedText)) return 100;
  // Token-by-token con tolerancia stem
  const nameTokens = normalizedName.split(/\s+/).filter((t) => t.length >= 3);
  if (nameTokens.length === 0) return 0;
  let matched = 0;
  for (const nt of nameTokens) {
    if (textTokens.some((tt) => stemEqual(tt, nt))) matched++;
  }
  if (matched === 0) return 0;
  const ratio = matched / nameTokens.length;
  return Math.round(ratio * 60);
}

function pickBest<T extends CatalogEntry>(
  scores: Array<{ entry: T; score: number }>,
): EntityMatch<T> {
  if (scores.length === 0) return { match: null, ambiguous: false };
  const best = scores[0];
  const runnerUp = scores[1];
  if (runnerUp && runnerUp.score >= best.score - 10) {
    return {
      match: null,
      ambiguous: true,
      candidates: scores.slice(0, 5).map((s) => s.entry),
    };
  }
  return { match: best.entry, ambiguous: false };
}

export function extractSaleEntities<P extends CatalogEntry, C extends CatalogEntry>(
  text: string,
  products: P[],
  customers: C[],
): { product: EntityMatch<P>; customer: EntityMatch<C> } {
  const normalizedText = normalizeForMatching(text);
  const textTokens = tokensFromText(text);

  const productScores = products
    .map((p) => ({ entry: p, score: scoreEntry(textTokens, normalizedText, p.name) }))
    .filter((s) => s.score >= 30)
    .sort((a, b) => b.score - a.score);

  const customerScores = customers
    .map((c) => ({ entry: c, score: scoreEntry(textTokens, normalizedText, c.name) }))
    .filter((s) => s.score >= 30)
    .sort((a, b) => b.score - a.score);

  return {
    product: pickBest(productScores),
    customer: pickBest(customerScores),
  };
}
