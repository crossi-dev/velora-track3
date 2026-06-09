import { normalizeForMatching } from "../shared";

export function getSupplierMatchScore(query: string, candidate: string) {
  const normalizedQuery = normalizeForMatching(query);
  const normalizedCandidate = normalizeForMatching(candidate);
  if (!normalizedQuery || !normalizedCandidate) return 0;
  if (normalizedQuery === normalizedCandidate) return 100;
  if (normalizedCandidate.includes(normalizedQuery) || normalizedQuery.includes(normalizedCandidate)) return 80;

  const queryTokens: string[] = normalizedQuery.match(/[a-z0-9]+/g) ?? [];
  const candidateTokens: string[] = normalizedCandidate.match(/[a-z0-9]+/g) ?? [];
  const overlap = queryTokens.filter((token) => candidateTokens.includes(token)).length;
  if (!overlap) return 0;
  return overlap * 10 + (candidateTokens.some((token) => queryTokens.includes(token)) ? 5 : 0);
}

export function findBestSupplierMatch<T extends { id: string; name: string }>(query: string, entries: T[]) {
  const normalizedQuery = normalizeForMatching(query);
  if (!normalizedQuery) return { match: null as T | null, ambiguous: false };

  const scoredEntries = entries
    .map((entry) => ({
      entry,
      score: getSupplierMatchScore(normalizedQuery, entry.name),
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

