"use client";

import { normalizeLookupText } from "../../../lib/shared-utils";

export type NamedEntry = { id?: string; name: string };

export const NUMBER_WORDS: Record<string, number> = {
  un: 1,
  una: 1,
  uno: 1,
  dos: 2,
  tres: 3,
  cuatro: 4,
  cinco: 5,
  seis: 6,
  siete: 7,
  ocho: 8,
  nueve: 9,
  diez: 10,
  once: 11,
  doce: 12,
  trece: 13,
  catorce: 14,
  quince: 15,
  veinte: 20,
  treinta: 30,
  cuarenta: 40,
  cincuenta: 50,
  sesenta: 60,
  setenta: 70,
  ochenta: 80,
  noventa: 90,
  cien: 100,
};

export const NON_DISTINCT_REPLY_TOKENS = new Set([
  "el",
  "la",
  "los",
  "las",
  "un",
  "una",
  "unos",
  "unas",
  "de",
  "del",
  "al",
  "para",
  "con",
  "y",
  "e",
  "a",
]);

function scoreNamedMatch(query: string, candidate: string) {
  const normalizedQuery = normalizeLookupText(query);
  const normalizedCandidate = normalizeLookupText(candidate);

  if (!normalizedQuery || !normalizedCandidate) return 0;
  if (normalizedQuery === normalizedCandidate) return 100;
  if (normalizedCandidate.includes(normalizedQuery) || normalizedQuery.includes(normalizedCandidate)) return 80;

  const queryTokens = normalizedQuery.split(" ").filter(Boolean);
  const candidateTokens = normalizedCandidate.split(" ").filter(Boolean);
  const overlap = queryTokens.filter((token) => candidateTokens.includes(token)).length;

  if (!overlap) return 0;
  return overlap * 10 + (candidateTokens.some((token) => queryTokens.includes(token)) ? 5 : 0);
}

export function findBestNamedMatch<T extends NamedEntry>(query: string, entries: T[]) {
  const scoredEntries = entries
    .map((entry) => ({
      entry,
      score: scoreNamedMatch(query, entry.name),
    }))
    .sort((left, right) => right.score - left.score);

  const best = scoredEntries[0];
  if (!best || best.score < 20) {
    return { match: null as T | null, score: 0, ambiguous: false };
  }

  const runnerUp = scoredEntries[1];
  if (runnerUp && runnerUp.score >= best.score - 10) {
    return { match: null as T | null, score: best.score, ambiguous: true };
  }

  return { match: best.entry, score: best.score, ambiguous: false };
}

function parseLocalizedNumber(value: string) {
  const cleaned = value.replace(/\s+/g, "");
  if (!cleaned) return Number.NaN;

  let normalized = cleaned;
  const hasCommaThousands = /^-?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(normalized);
  const hasDotThousands = /^-?\d{1,3}(?:\.\d{3})+(?:,\d+)?$/.test(normalized);

  if (hasDotThousands) {
    normalized = normalized.replace(/\./g, "").replace(",", ".");
  } else if (hasCommaThousands) {
    normalized = normalized.replace(/,/g, "");
  } else if (normalized.includes(",") && !normalized.includes(".")) {
    normalized = normalized.replace(",", ".");
  }

  return Number(normalized);
}

function extractWordNumber(text: string) {
  const normalized = normalizeLookupText(text);
  const tokens = normalized.split(" ").filter(Boolean);
  for (const token of tokens) {
    const candidate = NUMBER_WORDS[token];
    if (candidate) return candidate;
  }
  return null;
}

export function looksLikeSaleProductReply(reply: string, saleText: string) {
  const replyTokens = normalizeLookupText(reply)
    .split(" ")
    .filter((token) => token && !NON_DISTINCT_REPLY_TOKENS.has(token));
  if (!replyTokens.length) return false;

  const saleTokens = new Set(normalizeLookupText(saleText).split(" ").filter(Boolean));
  const overlappingTokens = replyTokens.filter((token) => saleTokens.has(token));

  return overlappingTokens.length > 0 && overlappingTokens.length / replyTokens.length >= 0.6;
}

export function extractQuantityFromSaleReply(text: string): number | null {
  const normalized = normalizeLookupText(text);
  if (!normalized) return null;

  const hasUnitTerms = /\b(unidad|unidades|u|ud|uds)\b/.test(normalized);
  const hasPriceTerms =
    /[$]/.test(text) || /\b(precio|valor|cuesta|sale a|costo|peso|pesos|ars)\b/.test(normalized);

  const numericMatch = text.match(/\d+(?:[.,]\d+)?/);
  const numericCandidate = numericMatch ? parseLocalizedNumber(numericMatch[0]) : Number.NaN;
  const wordCandidate = extractWordNumber(text);
  const candidate = Number.isFinite(numericCandidate) ? numericCandidate : wordCandidate;

  if (!candidate || candidate <= 0) return null;
  if (hasPriceTerms && !hasUnitTerms && !/^\d+$/.test(normalized)) return null;

  return Math.floor(candidate);
}

export function extractPriceFromSaleReply(text: string): number | null {
  const normalized = normalizeLookupText(text);
  if (!normalized) return null;

  const hasUnitTerms = /\b(unidad|unidades|u|ud|uds)\b/.test(normalized);
  const hasPriceTerms =
    /[$]/.test(text) || /\b(precio|valor|cuesta|sale a|costo|peso|pesos|ars)\b/.test(normalized);

  const numericMatches = Array.from(text.matchAll(/\d+(?:[.,]\d+)?/g))
    .map((match) => parseLocalizedNumber(match[0]))
    .filter((value) => Number.isFinite(value) && value > 0);
  const wordCandidate = extractWordNumber(text);
  const candidates = numericMatches.length > 0
    ? numericMatches
    : wordCandidate && wordCandidate > 0
      ? [wordCandidate]
      : [];

  if (!candidates.length) return null;
  if (!hasPriceTerms && hasUnitTerms) return null;

  return candidates[candidates.length - 1] ?? null;
}
