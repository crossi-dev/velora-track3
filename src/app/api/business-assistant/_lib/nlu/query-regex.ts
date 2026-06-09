// Canonical regex definitions for price/stock signal detection.
// Shared between the pre-model fast-path (price-query-fast-path.ts)
// and the post-model business-query handler (intent-handlers/business-query.ts).
//
// Price terms beat stock terms when both are present in the same phrase
// (e.g. "cuánto vale" carries both "vale" and a stock hint — price wins).
//
// "esta" deliberately removed as a standalone term — \b(esta)\b collided with
// demonstratives like "esta semana", "esta mercadería", causing false price
// signals in owner-handler.stages.ts:tryRescueStockPriceQuery (which has no
// secondary PRICE_PATTERNS safety net). The AR construction "¿a cuánto está?"
// is already covered by the "esta\s+(?:el|la|los|las)" pattern below, which
// requires an article and cannot collide with demonstratives.
// accent-stripped via normalizeForMatching so "está" → "esta" before matching.
export const PRICE_QUERY_RE =
  /\b(vale|valen|cuesta|cuestan|precio|precios|sale|salen|valor|costo)\b|\besta\s+(?:el|la|los|las)\b/;
export const STOCK_QUERY_RE =
  /\b(stock|inventario|cantidad|unidades|tengo|tenes|tiene|hay|queda|quedan)\b/;
