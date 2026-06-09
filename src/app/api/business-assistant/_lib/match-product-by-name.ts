import { levenshteinDistance, normalizeForMatching } from "./shared";

interface ProductRef {
  id: string;
  name: string;
}

// Fuzzy-matches a model-provided product name against the catalog.
// Used by compound-action extractors and the multi-edit handler where
// the model may return an abbreviated or accent-stripped product name
// that doesn't exactly equal the catalog entry.
//
// Order:
//   1. Exact case-insensitive match
//   2. Normalized (accent-stripped) substring — longest catalog name wins
//   3. Levenshtein ≤1 (names ≤6 chars) / ≤2 (longer) — first acceptable hit
//
// Returns null when nothing meets the thresholds. Intentionally strict on
// short queries (<3 chars) to avoid matching "a" to "Arena".
export function matchProductByName<T extends ProductRef>(
  query: string,
  catalog: T[]
): T | null {
  const trimmed = query.trim();
  if (!trimmed || trimmed.length < 2 || catalog.length === 0) return null;

  const lower = trimmed.toLowerCase();
  const exact = catalog.find((p) => p.name.toLowerCase() === lower);
  if (exact) return exact;

  const normalizedQuery = normalizeForMatching(trimmed);
  if (normalizedQuery.length < 3) return null;

  const substringCandidates = catalog
    .map((p) => ({ entry: p, normalized: normalizeForMatching(p.name) }))
    .filter(({ normalized }) => {
      if (normalized.length < 3) return false;
      return normalized.includes(normalizedQuery) || normalizedQuery.includes(normalized);
    })
    .sort((a, b) => b.normalized.length - a.normalized.length);

  if (substringCandidates.length > 0) {
    return substringCandidates[0].entry;
  }

  const lenThreshold = normalizedQuery.length <= 6 ? 1 : 2;
  for (const entry of catalog) {
    const normalized = normalizeForMatching(entry.name);
    if (normalized.length < 3) continue;
    if (Math.abs(normalized.length - normalizedQuery.length) > lenThreshold) continue;
    if (levenshteinDistance(normalized, normalizedQuery) <= lenThreshold) {
      return entry;
    }
  }

  return null;
}

// Looser threshold for "¿Quisiste decir X?" suggestions.
// Returns the single closest catalog product if Levenshtein distance ≤ 3,
// null otherwise. Never called when matchProductByName already succeeded.
export function suggestProductMatch<T extends ProductRef>(
  query: string,
  catalog: T[],
): T | null {
  const trimmed = query.trim();
  if (!trimmed || trimmed.length < 3 || catalog.length === 0) return null;
  const normalizedQuery = normalizeForMatching(trimmed);
  if (normalizedQuery.length < 3) return null;
  let best: T | null = null;
  let bestDist = 4;
  for (const entry of catalog) {
    const normalized = normalizeForMatching(entry.name);
    if (normalized.length < 3) continue;
    const dist = levenshteinDistance(normalized, normalizedQuery);
    if (dist < bestDist) { bestDist = dist; best = entry; }
  }
  return best;
}
