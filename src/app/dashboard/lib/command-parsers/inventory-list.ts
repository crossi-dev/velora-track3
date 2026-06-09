import type { VeloraSingleCommand } from "./shared";

// Matches inventory-wide read-only queries — no product name required.
// These used to fall through to the AI and came back as "No entendí..."
// because the system prompt lets business_query return an empty answer
// and the handler had no fallback. Matching locally here is cheaper,
// deterministic, and reuses the catalog already loaded in the browser.
//
// Two families of phrasings:
//   1. Explicit inventory keywords — "stock completo", "inventario",
//      "todo el stock", "todos los productos", "catálogo".
//   2. Bare stock/inventory noun with no product name — "stock",
//      "dame el stock", "decime el inventario". When there's no
//      product after the keyword, it's a full-inventory ask.
const INVENTORY_LIST_PATTERNS: RegExp[] = [
  // 1a. Request-prefixed, explicit keyword
  /^(?:decime|deci|dame|mostrame|mostra|listame|lista|enumera|enumerame|fijate|a\s+ver)\s+(?:el\s+|la\s+|lo\s+|los\s+|las\s+)?(?:stock\s+completo|inventario(?:\s+completo)?|todo\s+el\s+(?:stock|inventario)|todos?\s+los\s+productos|catalogo(?:\s+completo)?)\??$/,
  // 1b. Bare, explicit keyword
  /^(?:stock\s+completo|inventario(?:\s+completo)?|todo\s+el\s+(?:stock|inventario)|todos?\s+los\s+productos|catalogo(?:\s+completo)?)\??$/,
  // 2a. Request-prefixed + bare "stock" / "inventario" (no product name after)
  /^(?:decime|deci|dame|mostrame|mostra|listame|lista|enumera|enumerame|fijate|a\s+ver)\s+(?:el\s+|la\s+|lo\s+|los\s+|las\s+)?(?:stock|inventario|catalogo)\??$/,
  // 2b. Bare "stock" / "inventario" on its own
  /^(?:stock|inventario|catalogo)\??$/,
  // 3. "qué productos tengo", "qué hay en stock"
  /^(?:que|cuales)\s+productos\s+(?:tengo|tenemos|hay)\??$/,
  /^que\s+hay\s+en\s+(?:stock|inventario)\??$/,
];

export function detectInventoryList(normalized: string): VeloraSingleCommand | null {
  for (const pattern of INVENTORY_LIST_PATTERNS) {
    if (pattern.test(normalized)) {
      return { matched: true, intent: "inventory_list", data: {} };
    }
  }
  return null;
}
