import {
  cleanProductName,
  resolveProductName,
  type ProductCatalogItem,
  type VeloraSingleCommand,
} from "./shared";

// Request verbs consumed at the start of the input before patterns run,
// so "decime el stock de X" / "mostrame cuántas X tengo" match the same
// patterns as bare "stock de X" / "cuántas X tengo".
const REQUEST_PREFIX_RE =
  /^(?:decime|deci|decila|decilo|dame|damelo|damela|mostrame|mostra|fijate|fijame|chequea|a\s+ver)\s+(?:el\s+|la\s+|lo\s+|los\s+|las\s+)?/;

// Patterns that signal a stock-level query. Each capture group yields the
// product candidate. Order matters — more specific patterns first. The
// last pattern is the bare "cuantas X" form (verb elided) which ferretería
// users say conversationally. The verb-less form can over-match phrases
// like "cuanto vale la yerba" (price query) but the PRICE_QUERY_GUARD_RE
// below rejects those before any pattern runs.
const CHECK_STOCK_PATTERNS: RegExp[] = [
  /^(?:cuanto|cuanta|cuantos|cuantas)\s+(?:hay|queda|quedan)\s+(?:de\s+)?(.+?)\??$/,
  /^(?:cuanto|cuanta|cuantos|cuantas)\s+(.+?)\s+(?:tengo|tenemos|tenes|tiene|hay|me\s+queda|me\s+quedan)\??$/,
  // "cuánto stock tiene (la) yerba" / "qué stock tiene yerba" — server-side
  // phrasings migrated from pre-model-router's looksLikeSpecificProductStockQuery.
  /^(?:cuanto|cuanta|cuantos|cuantas|que)\s+stock\s+tiene(?:n)?\s+(?:el\s+|la\s+|los\s+|las\s+)?(.+?)\??$/,
  // "cuántas unidades (hay|quedan) (de) X"
  /^(?:cuanto|cuanta|cuantos|cuantas)\s+unidades\s+(?:hay|queda|quedan)\s+(?:de\s+)?(.+?)\??$/,
  // "cuántas unidades (de) X (tengo|hay|quedan)" — product in the middle
  /^(?:cuanto|cuanta|cuantos|cuantas)\s+unidades\s+(?:de\s+)?(.+?)\s+(?:tengo|tenemos|tenes|tiene|hay|queda|quedan)\??$/,
  /^stock\s+de\s+(.+?)\??$/,
  /^inventario\s+de\s+(.+?)\??$/,
  /^me\s+queda(?:n)?\s+(.+?)\??$/,
  /^hay\s+(?!que\b)(.+?)\??$/,
  // Bare "cuantas X" — verb elided. Capture is capped at 3 words because
  // real product names rarely exceed that and 4+ words is a strong signal
  // it's a different question (e.g. "cuantas personas me haran falta…").
  // Longer inputs fall through to the AI for proper handling.
  /^(?:cuanto|cuanta|cuantos|cuantas)\s+(\S+(?:\s+\S+){0,2})\??$/,
];

// Anti-guard: price-query verbs belong to a different server-side intent.
// We reject here so the server handles "cuánto vale X" / "cuánto cuesta X"
// rather than letting check_stock over-match.
const PRICE_QUERY_GUARD_RE = /\b(?:vale|valen|cuesta|cuestan|sale|salen|precio|precios)\b/;

// Anti-guard: nouns that look like product candidates but aren't.
// "cuántos clientes tenemos" would otherwise capture "clientes" and try
// to resolve it as a product. Reject so the AI handles this as a
// business_query (count of customers, suppliers, etc.) or general
// conversation, instead of a misleading "No encontré 'clientes' en tu
// catálogo" reply.
//
// Forms are normalized (lowercase + accent-stripped) because
// normalizeForMatching has already run by the time productName reaches
// the per-token check. So "días" appears as "dias", "años" as "anos".
const NON_PRODUCT_NOUNS = new Set([
  // Roles / contacts
  "cliente", "clientes",
  "proveedor", "proveedores",
  "contacto", "contactos",
  "gente",
  "usuario", "usuarios",
  "fabricante", "fabricantes",
  "vendedor", "vendedores",
  // Generic abstract nouns common in conversational questions
  "persona", "personas",
  "cosa", "cosas",
  "vez", "veces",
  "tiempo", "tiempos",
  "hora", "horas",
  "dia", "dias",
  "mes", "meses",
  "ano", "anos",
  "semana", "semanas",
  "empleado", "empleados",
  "trabajador", "trabajadores",
  // Currency tokens — "cuantos pesos hay en caja" should reach AI as a
  // cash_balance / business_query, not check_stock.
  "peso", "pesos",
]);

export function detectCheckStock(
  normalized: string,
  products: ProductCatalogItem[]
): VeloraSingleCommand | null {
  if (PRICE_QUERY_GUARD_RE.test(normalized)) return null;

  // normalizeForMatching keeps "¿"/"¡" — strip so `^` anchors fire for
  // typed Spanish questions ("¿cuánto stock tiene la yerba?").
  const cleaned = normalized.replace(/^[¿¡]+\s*/, "").trim();
  const stripped = cleaned.replace(REQUEST_PREFIX_RE, "").trim();
  const candidates = stripped && stripped !== cleaned ? [stripped, cleaned] : [cleaned];

  for (const text of candidates) {
    for (const pattern of CHECK_STOCK_PATTERNS) {
      const m = text.match(pattern);
      if (!m) continue;
      const productName = cleanProductName(m[1].trim());
      if (!productName || productName.length < 2) continue;
      // Per-token check: reject if ANY word in the candidate is a known
      // non-product noun. Catches multi-word phrases like "personas me
      // haran falta" where the bare pattern would otherwise capture the
      // full string and try to resolve it as a product.
      const tokens = productName.toLowerCase().split(/\s+/);
      if (tokens.some((tok) => NON_PRODUCT_NOUNS.has(tok))) continue;
      const productMatch = resolveProductName(productName, products);
      return {
        matched: true,
        intent: "check_stock",
        data: { productName, productId: productMatch?.id ?? null },
      };
    }
  }
  return null;
}
