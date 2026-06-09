import { normalizeSkuLookup } from "@/infrastructure/shared/product-sku";
import { normalizeForMatching } from "@/lib/normalize";

// Delegates to canonical normalizeForMatching (NFKC\u2192NFD\u2192\p{M} strip \u2014 covers
// Supplement and Half-Mark combining blocks missed by the old [\u0300-\u036f] range).
// Token-based scoring in getNameMatchScore is robust to the difference in
// punctuation handling (both query and candidate are normalized symmetrically).
// Dedup 2026-05-29 \u2014 private copy consolidated to canonical.
export function normalizeLookupText(value: string): string {
  return normalizeForMatching(String(value ?? "").trim());
}

export function getNameMatchScore(query: string, candidate: string) {
  if (!query || !candidate) return 0;
  if (query === candidate) return 100;
  if (candidate.includes(query) || query.includes(candidate)) return 80;

  const queryTokens = query.split(" ").filter(Boolean);
  const candidateTokens = candidate.split(" ").filter(Boolean);
  const overlap = queryTokens.filter((token) => candidateTokens.includes(token)).length;

  if (!overlap) return 0;
  return overlap * 10 + (candidateTokens.some((token) => queryTokens.includes(token)) ? 5 : 0);
}

export function findBestProductMatch<T extends { name: string; sku?: string | null }>(query: string, entries: T[]) {
  // Only attempt SKU matching if query looks like a SKU (contains digits or is very short)
  const normalizedSkuQuery = normalizeSkuLookup(query);
  if (normalizedSkuQuery && (/\d/.test(normalizedSkuQuery) || normalizedSkuQuery.length <= 6)) {
    const exactSkuMatches = entries.filter(
      (entry) => normalizeSkuLookup(entry.sku) === normalizedSkuQuery
    );

    if (exactSkuMatches.length === 1) {
      return exactSkuMatches[0] ?? null;
    }
  }

  const normalizedQuery = normalizeLookupText(query);
  if (!normalizedQuery) return null;

  let best: T | null = null;
  let bestScore = 0;

  for (const entry of entries) {
    const score = getNameMatchScore(normalizeLookupText(entry.name), normalizedQuery);
    if (score > bestScore) {
      best = entry;
      bestScore = score;
    }
  }

  return bestScore >= 20 ? best : null;
}

export function findAmbiguousNameMatch<T extends { name: string }>(query: string, entries: T[]) {
  const normalizedQuery = normalizeLookupText(query);
  if (!normalizedQuery) return { match: null as T | null, ambiguous: false };

  const scoredEntries = entries
    .map((entry) => ({
      entry,
      score: getNameMatchScore(normalizeLookupText(entry.name), normalizedQuery),
    }))
    .sort((left, right) => right.score - left.score);

  const best = scoredEntries[0];
  if (!best || best.score < 20) {
    return { match: null as T | null, ambiguous: false };
  }

  const runnerUp = scoredEntries[1];
  if (runnerUp && runnerUp.score >= 20 && runnerUp.score >= best.score - 5) {
    return { match: null as T | null, ambiguous: true };
  }

  return { match: best.entry, ambiguous: false };
}

export { normalizePersonOrBusinessName } from "../../../../lib/normalize";

export function isWeakSaleCustomerName(value: string) {
  const normalized = normalizeLookupText(value);
  if (!normalized) return true;

  const genericLabels = new Set([
    "consumidor",
    "consumidor final",
    "cliente",
    "cliente final",
    "final",
    "cf",
  ]);

  if (genericLabels.has(normalized)) return true;
  if (normalized.length <= 2) return true;

  const tokens = normalized.split(" ").filter(Boolean);
  if (tokens.length === 1 && tokens[0].length <= 2) return true;

  return false;
}

export function customerClarificationMessage(reason: "missing" | "ambiguous" | "invalid" | "not_found") {
  if (reason === "ambiguous") {
    return "Encontré varios clientes parecidos. Decime cuál es o elegí uno existente.";
  }

  if (reason === "not_found") {
    return "No encontré ese cliente. Decime cuál es o crealo primero antes de registrar la venta.";
  }

  if (reason === "invalid") {
    return "No pude confirmar el cliente seleccionado. Elegí uno existente o decime el nombre completo.";
  }

  return "Necesito un nombre de cliente claro para registrar la venta. Decime el nombre completo o elegí un cliente existente.";
}
