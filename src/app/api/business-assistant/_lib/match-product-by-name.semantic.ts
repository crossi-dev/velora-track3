// Semantic product matching via Vertex AI Search as fallback to SQL fuzzy.
//
// Strategy:
//   1. Exact case-insensitive match → return immediately (no Vertex call)
//   2. Normalized substring match → return immediately (no Vertex call)
//   3. SQL fuzzy found nothing + businessId present + Vertex enabled →
//      call Vertex Search, filter hits with score >= 0.7, verify id exists
//      in the local catalog (defense against stale indexes), return top hit.
//
// Returns null when no match meets quality thresholds.

import {
  searchProductsSemantically,
  isVertexSearchEnabled,
} from "../../../../lib/vertex-search";

interface ProductRef {
  id: string;
  name: string;
}

const VERTEX_SCORE_THRESHOLD = 0.7;

function normalizeSimple(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function sqlFuzzyMatch<T extends ProductRef>(
  query: string,
  catalog: T[],
): T | null {
  const lower = query.toLowerCase().trim();
  if (!lower || lower.length < 2) return null;

  // Exact case-insensitive
  const exact = catalog.find((p) => p.name.toLowerCase() === lower);
  if (exact) return exact;

  // Normalized substring
  const normalizedQuery = normalizeSimple(query);
  if (normalizedQuery.length < 3) return null;

  const substringMatch = catalog.find((p) => {
    const normalizedName = normalizeSimple(p.name);
    return (
      normalizedName.includes(normalizedQuery) ||
      normalizedQuery.includes(normalizedName)
    );
  });
  return substringMatch ?? null;
}

/**
 * Match a product name against the catalog using SQL fuzzy first, then
 * Vertex AI Search as semantic fallback.
 */
export async function matchProductByNameSemantic<T extends ProductRef>(
  query: string,
  catalog: T[],
  businessId: string | undefined,
): Promise<T | null> {
  if (!query || catalog.length === 0) return null;

  // SQL fuzzy short-circuit — no Vertex call needed
  const sqlHit = sqlFuzzyMatch(query, catalog);
  if (sqlHit) return sqlHit;

  // No businessId → can't call Vertex (per-tenant datastore requires it)
  if (!businessId) return null;

  // Vertex disabled → give up
  if (!isVertexSearchEnabled()) return null;

  const hits = await searchProductsSemantically({ businessId, query });
  if (!hits || hits.length === 0) return null;

  // Sort desc by score (caller contract: hits may arrive in any order)
  const sorted = [...hits].sort((a, b) => b.score - a.score);
  const top = sorted[0];

  if (top.score < VERTEX_SCORE_THRESHOLD) return null;

  // Defense against stale indexes: verify the id is still in the local catalog
  const catalogHit = catalog.find((p) => p.id === top.id);
  return catalogHit ?? null;
}
