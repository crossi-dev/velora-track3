import { normalizeActionText, normalizeForMatching } from "../shared";
import { computeNameMatchScore, fuzzyProductMatch } from "./match-score";
import { normalizeSkuLookup } from "@/infrastructure/shared/product-sku";
import type { ProductInfoEntry } from "../types";

export function looksLikeQuestionStyleRequest(text: string) {
  const normalized = normalizeForMatching(text);
  return (
    text.includes("?") ||
    [
      "cuanto",
      "cuantos",
      "cuanta",
      "cuantas",
      "cual",
      "cuales",
      "que",
      "mostra",
      "mostrar",
      "mostrame",
      "decime",
      "dime",
    ].some((term) => normalized.includes(term))
  );
}

export function stripParenthetical(value: string) {
  return value.replace(/\s*\([^)]*\)\s*/g, " ").trim();
}


export function cleanupProductName(value: string) {
  return value
    .replace(
      /\b(?:precio|vale|cuesta|sale\s+a|valor|costo|costo\s*unitario|me\s+cuesta|sku|codigo|código|cod|stock|cantidad|unidades|nombre|se\s+llama)\b[\s:=].*$/i,
      ""
    )
    // Strip leading Rioplatense voseo imperative verbs that the supervisor
    // sometimes extracts as a "product name" (e.g. user says "Decime stock"
    // and the LLM passes product_name="decime"). Canonical 2026 IR pattern —
    // domain stopwords filtered before catalog lookup. Add new verbs here
    // when audits surface them; keep this list explicit rather than regex-
    // generic to avoid stripping legitimate product names that start with
    // these letters.
    .replace(/^(?:decime|dame|mostrame|mostrá|mostra|mandame|pasame|tirame|fijate|chequeame|busca|buscame|dime|muéstrame|muestrame)\s+/i, "")
    .replace(/^(?:producto|ítem|articulo|artículo)\s+/i, "")
    .replace(/^(?:llamado|llamada)\s+/i, "")
    .replace(/^(?:el|la|los|las)\s+/i, "")
    .replace(/\bcon\s*$/i, "")
    .replace(/^[\s"'`""]+|[\s"'`"".,;:]+$/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function cleanupSupplierName(value: string) {
  return value
    .replace(
      /\b(?:telefono|tel[eé]fono|celular|cel|whatsapp|email|correo|mail|contacto|responsable|encargado|dni|cuit|cuil|documento|doc|tax\s*id|taxid)\b[\s:=].*$/i,
      ""
    )
    .replace(/^(?:nuevo|nueva)\s+/i, "")
    .replace(/^(?:proveedor|fabricante)\s+/i, "")
    .replace(/^(?:llamado|llamada)\s+/i, "")
    .replace(/\b(?:con)\s*$/i, "")
    .replace(/^[\s"'`""]+|[\s"'`"".,;:]+$/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function findBestProductMatch<T extends { id: string; name: string; sku?: string | null }>(query: string, entries: T[]) {
  const normalizedSkuQuery = normalizeSkuLookup(query);
  // Only attempt SKU matching if query looks like a SKU (contains digits or is very short)
  if (normalizedSkuQuery && (/\d/.test(normalizedSkuQuery) || normalizedSkuQuery.length <= 6)) {
    const exactSkuMatches = entries.filter(
      (entry) => normalizeSkuLookup(entry.sku) === normalizedSkuQuery
    );

    if (exactSkuMatches.length === 1) {
      return { match: exactSkuMatches[0] ?? null, ambiguous: false };
    }

    if (exactSkuMatches.length > 1) {
      return { match: null as T | null, ambiguous: true };
    }
  }

  const normalizedQuery = normalizeForMatching(query);
  if (!normalizedQuery) return { match: null as T | null, ambiguous: false };

  const scoredEntries = entries
    .map((entry) => ({
      entry,
      score: computeNameMatchScore(normalizedQuery, entry.name, true),
    }))
    .sort((left, right) => right.score - left.score);

  const best = scoredEntries[0];
  if (!best || best.score < 20) {
    return { match: null as T | null, ambiguous: false };
  }

  const runnerUp = scoredEntries[1];
  if (runnerUp && runnerUp.score > 0 && runnerUp.score >= best.score - 5) {
    return { match: null as T | null, ambiguous: true };
  }

  return { match: best.entry, ambiguous: false };
}

export function findProductInfoMatch(text: string, products: ProductInfoEntry[]) {
  // Extract SKU-like tokens from text (alphanumeric with at least one digit, e.g. "ABC001", "A1")
  const skuTokens = text.match(/\b[A-Za-z0-9]*\d[A-Za-z0-9]*\b/g) ?? [];
  for (const token of skuTokens) {
    const normalizedToken = normalizeSkuLookup(token);
    if (!normalizedToken) continue;
    const skuMatch = products.find((product) => {
      const normalizedSku = normalizeSkuLookup(product.sku);
      return Boolean(normalizedSku) && normalizedSku === normalizedToken;
    });
    if (skuMatch) return { match: skuMatch, ambiguous: false };
  }

  const normalizedText = normalizeForMatching(text);
  const directMatches = [...products]
    .filter((product) => {
      const normalizedProductName = normalizeForMatching(product.name);
      const strippedProductName = normalizeForMatching(stripParenthetical(product.name));
      return (
        (normalizedProductName.length > 0 && normalizedText.includes(normalizedProductName)) ||
        (strippedProductName.length > 0 && normalizedText.includes(strippedProductName))
      );
    })
    .sort((left, right) => right.name.length - left.name.length);

  if (directMatches.length === 1) return { match: directMatches[0], ambiguous: false };
  if (directMatches.length > 1) {
    // If the longest name is strictly longer than the runner-up, it's a specific match (e.g. "Filtro Bosch" vs "Filtro")
    const best = directMatches[0];
    const runnerUp = directMatches[1];
    if (normalizeForMatching(best.name).length > normalizeForMatching(runnerUp.name).length) return { match: best, ambiguous: false };
    return { match: null, ambiguous: true };
  }

  const quotedMatch = text.match(/"([^"\n]+)"|[\u201C]([^\u201D\n]+)[\u201D]|'([^'\n]+)'/);
  const referencedName = normalizeActionText(quotedMatch?.[1] ?? quotedMatch?.[2] ?? quotedMatch?.[3] ?? "");
  if (referencedName) {
    return findBestProductMatch(referencedName, products);
  }

  const patterns = [
    /\b(?:precio|vale|cuesta|valor|stock|inventario|cantidad)\s+(?:de|del)\s+([^,.;\n]+)/i,
    /\b(?:cuanto|cuanta)\s+(?:vale|cuesta|sale|stock|hay de|tiene de)\s+([^,.;\n]+)/i,
    /\b(?:mostra|mostrar|mostrame)\s+(?:el\s+)?(?:precio|stock|inventario)\s+(?:de|del)\s+([^,.;\n]+)/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    const raw = normalizeActionText(match?.[1] ?? "")
      .replace(/^(?:hay\s+de|hay|de\s+el|del|de\s+la|de)\s+/i, "");
    const candidate = cleanupProductName(raw);
    if (!candidate) continue;
    return findBestProductMatch(candidate, products);
  }

  // Fuzzy fallback — only after exact + substring + token + pattern matching all fail.
  // Conservative: 1-edit budget for short names (≤6 chars), 2-edit for longer.
  // Single clear candidate required; multiple candidates → disambiguate, never guess.
  // This is a money path — a wrong match registers a wrong sale.
  const normalizedInput = normalizeForMatching(text);
  return fuzzyProductMatch(normalizedInput, products);
}
