/**
 * Homophone/mishearing recovery for voice transcriptions.
 * Replaces words in a normalized transcription with matching catalog item
 * names when Levenshtein distance ≤ 2 (not an exact match).
 */

import { normalizeForMatching } from "@/lib/normalize";

function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

function normalizeToken(w: string): string {
  return normalizeForMatching(w).replace(/[^a-z0-9]/g, "");
}

function buildCatalogWordMap(catalog: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const item of catalog) {
    for (const word of item.split(/\s+/)) {
      const norm = normalizeToken(word);
      if (norm.length >= 4) map.set(norm, word);
    }
  }
  return map;
}

/**
 * Recovers catalog item names from voice-misheard words.
 * For each word in `input`, if a catalog word is within Levenshtein distance
 * ≤ 2 (and not an exact match), substitutes the input word with the catalog form.
 * Words shorter than 4 characters are skipped to avoid false positives.
 * Substitutions are logged via console.log so they appear in dev tools.
 */
export function recoverHomophones(input: string, catalog: string[]): string {
  if (!input.trim() || catalog.length === 0) return input;

  const catalogWords = buildCatalogWordMap(catalog);
  const tokens = input.split(/(\s+)/);
  const result: string[] = [];

  for (const token of tokens) {
    if (/^\s+$/.test(token)) { result.push(token); continue; }
    const normToken = normalizeToken(token);
    if (normToken.length < 4) { result.push(token); continue; }

    let bestWord: string | null = null;
    let bestDist = 3; // rejects distance ≥ 3; effective threshold is 2
    for (const [normCatalog, original] of catalogWords) {
      const dist = levenshteinDistance(normToken, normCatalog);
      if (dist > 0 && dist < bestDist) { bestDist = dist; bestWord = original; }
    }

    if (bestWord) {
      result.push(bestWord);
    } else {
      result.push(token);
    }
  }

  return result.join("");
}
