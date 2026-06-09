import { normalizeForMatching } from "../shared";

/**
 * Classic iterative Levenshtein edit distance.
 * Returns the number of single-character edits (insert/delete/substitute) needed.
 */
export function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  // Allocate two rows only — O(n) space
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let curr = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      curr[j] = a[i - 1] === b[j - 1]
        ? prev[j - 1]
        : 1 + Math.min(prev[j - 1], prev[j], curr[j - 1]);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

/**
 * Fuzzy fallback: returns the single product within edit-distance budget,
 * or null if zero or multiple candidates are within budget (ambiguous / no match).
 *
 * Budget (conservative — money path):
 *   name length ≤ 6  → max 1 edit
 *   name length  > 6 → max 2 edits
 * The budget is computed against the SHORTER of query vs product name to
 * avoid matching "pan" against "panorama" on a 2-edit budget.
 */
export function fuzzyProductMatch<T extends { name: string }>(
  query: string,
  entries: T[],
): { match: T | null; ambiguous: boolean } {
  const normedQuery = normalizeForMatching(query);
  if (!normedQuery || normedQuery.length < 3) {
    return { match: null, ambiguous: false };
  }

  const budget = normedQuery.length <= 6 ? 1 : 2;

  const close: T[] = [];
  for (const entry of entries) {
    const normedName = normalizeForMatching(entry.name);
    if (!normedName) continue;
    const minLen = Math.min(normedQuery.length, normedName.length);
    const effectiveBudget = minLen <= 6 ? 1 : 2;
    const dist = editDistance(normedQuery, normedName);
    if (dist > 0 && dist <= Math.min(budget, effectiveBudget)) {
      close.push(entry);
    }
  }

  if (close.length === 1) return { match: close[0]!, ambiguous: false };
  if (close.length > 1) return { match: null, ambiguous: true };
  return { match: null, ambiguous: false };
}

/**
 * Scores fuzzy name match quality (0-100). Higher = better match.
 * stripParens: products have SKUs in parens like "Filtro (ABC001)"; strip before comparing.
 */
export function computeNameMatchScore(
  query: string,
  candidate: string,
  stripParens = false,
): number {
  const prep = (s: string) => stripParens ? s.replace(/\s*\([^)]*\)\s*/g, " ").trim() : s;
  const normalizedQuery = normalizeForMatching(prep(query));
  const normalizedCandidate = normalizeForMatching(prep(candidate));
  if (!normalizedQuery || !normalizedCandidate) return 0;
  if (normalizedQuery === normalizedCandidate) return 100;
  if (normalizedCandidate.includes(normalizedQuery) || normalizedQuery.includes(normalizedCandidate)) return 80;
  const queryTokens: string[] = normalizedQuery.match(/[a-z0-9]+/g) ?? [];
  const candidateTokens: string[] = normalizedCandidate.match(/[a-z0-9]+/g) ?? [];
  const overlap = queryTokens.filter((token) => candidateTokens.includes(token)).length;
  if (!overlap) return 0;
  return overlap * 10 + 5;
}
