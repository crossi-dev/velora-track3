import { levenshteinDistance, normalizeForMatching } from "../shared";
import { GRAMMATICAL_STOPWORDS_ES, DOMAIN_QUERY_WORDS_ES } from "../../../../../lib/stopwords";

interface ProductRef {
  id: string;
  name: string;
}

const DEFAULT_LIMIT = 3;

// Returns the top N catalog candidates for an ambiguous query, ranked by
// relevance (exact > substring > Levenshtein). Used to surface a
// "¿quisiste decir?" picker when product matching is ambiguous.
//
// Never returns more than `limit` entries. Entries below the relevance
// floor are dropped — better to show nothing than noise.
export function getProductCandidates<T extends ProductRef>(
  query: string,
  catalog: T[],
  limit = DEFAULT_LIMIT
): T[] {
  const trimmed = query.trim();
  if (!trimmed || trimmed.length < 2 || catalog.length === 0) return [];

  const normalizedQuery = normalizeForMatching(trimmed);
  if (normalizedQuery.length < 2) return [];

  const scored = catalog
    .map((entry) => {
      const normalizedName = normalizeForMatching(entry.name);
      return { entry, score: scoreCandidate(normalizedQuery, normalizedName) };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score);

  return scored.slice(0, limit).map((s) => s.entry);
}

// Canonical source: src/lib/stopwords.ts — grammatical + catalog-query words.
// Do NOT add words here; add to the appropriate set in stopwords.ts so all
// three callers (extract-sale-entities, product-match-validator, here) benefit.
const STOPWORDS = new Set([
  ...GRAMMATICAL_STOPWORDS_ES,
  ...DOMAIN_QUERY_WORDS_ES,
]);

function scoreCandidate(query: string, name: string): number {
  if (!query || !name) return 0;
  if (name === query) return 100;
  if (name.includes(query)) {
    return 70 - Math.min(30, Math.abs(name.length - query.length));
  }
  if (query.includes(name)) {
    return 60 - Math.min(20, Math.abs(query.length - name.length));
  }

  const wholeDistance = levenshteinDistance(query, name);
  const wholeThreshold = Math.min(query.length, name.length) <= 6 ? 1 : 2;
  if (wholeDistance <= wholeThreshold) return 40 - wholeDistance * 5;

  // Cross-word matching: for each meaningful word in query, find the
  // best match against words in the catalog name. Handles cases like
  // query="cuanto vale la arena" vs name="Arena Gruesa" where
  // full-string similarity fails but "arena" → "Arena" is a clean hit.
  const queryWords = query.split(/\s+/).filter((w) => w.length >= 3 && !STOPWORDS.has(w));
  const nameWords = name.split(/\s+/).filter((w) => w.length >= 3);
  if (queryWords.length === 0 || nameWords.length === 0) return 0;

  let totalWordScore = 0;
  let matchedWords = 0;
  for (const qw of queryWords) {
    let bestForThisQueryWord = 0;
    for (const nw of nameWords) {
      if (nw === qw) { bestForThisQueryWord = 30; break; }
      if (nw.includes(qw) || qw.includes(nw)) {
        bestForThisQueryWord = Math.max(bestForThisQueryWord, 25);
        continue;
      }
      const distance = levenshteinDistance(qw, nw);
      const threshold = Math.min(qw.length, nw.length) <= 6 ? 1 : 2;
      if (distance <= threshold) {
        bestForThisQueryWord = Math.max(bestForThisQueryWord, 20 - distance * 3);
      }
    }
    if (bestForThisQueryWord > 0) {
      totalWordScore += bestForThisQueryWord;
      matchedWords += 1;
    }
  }
  if (matchedWords === 0) return 0;
  return totalWordScore;
}
