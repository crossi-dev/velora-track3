import { normalizeForMatching } from "./shared";
import type { AssistantBusinessPromptContext } from "./types";

const MAX_PRODUCTS_IN_PROMPT = 30;

function extractKeywords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[¿?¡!,.:;()]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3)
    .map(normalizeForMatching);
}

function scoreAndSort<T extends { name: string }>(items: T[], tokens: string[]): T[] {
  return items
    .map((item) => {
      const normalized = normalizeForMatching(item.name);
      let score = 0;
      for (const token of tokens) {
        if (normalized.includes(token) || token.includes(normalized)) score += 2;
        else if (normalized.startsWith(token.slice(0, 4))) score += 1;
      }
      return { item, score };
    })
    .sort((a, b) => b.score - a.score)
    .map(({ item }) => item);
}

export function trimContextProducts(
  context: AssistantBusinessPromptContext,
  userMessage: string,
): AssistantBusinessPromptContext {
  const products = context.products ?? [];
  if (products.length <= MAX_PRODUCTS_IN_PROMPT) return context;

  const tokens = extractKeywords(userMessage);

  // No keywords long enough → keep first N alphabetically (already sorted)
  const trimmedProducts = tokens.length === 0
    ? products.slice(0, MAX_PRODUCTS_IN_PROMPT)
    : scoreAndSort(products, tokens).slice(0, MAX_PRODUCTS_IN_PROMPT);

  const keptNames = new Set(trimmedProducts.map((p) => p.name.toLowerCase()));

  return {
    ...context,
    products: trimmedProducts,
    catalog: context.catalog
      ? {
          ...context.catalog,
          products: (context.catalog.products ?? [])
            .filter((p) => keptNames.has(p.name.toLowerCase()))
            .slice(0, MAX_PRODUCTS_IN_PROMPT),
        }
      : context.catalog,
  };
}
