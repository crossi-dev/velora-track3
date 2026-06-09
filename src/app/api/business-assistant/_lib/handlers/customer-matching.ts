import { normalizeForMatching } from "../shared";
import { computeNameMatchScore } from "./match-score";

export function findBestCustomerMatch<T extends { id: string; name: string }>(query: string, entries: T[]) {
  const normalizedQuery = normalizeForMatching(query);
  if (!normalizedQuery) return { match: null as T | null, ambiguous: false };

  const scoredEntries = entries
    .map((entry) => ({
      entry,
      score: computeNameMatchScore(normalizedQuery, entry.name),
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
