// stock-query Fast Path detector — read-only query "¿cuánto stock tengo
// de X?" off the Gemini Pro Slow Path (~8-15s cross-region). Pure NLU
// detector: identifies the intent, extracts the product fragment from
// the text, returns null if it can't.
//
// Resolution against the catalog is intentionally deferred to the
// executor — keeps the detector single-responsibility (text → intent)
// and lets the executor reuse `findProductInfoMatch` which already
// handles fuzzy/SKU/quoted-name matching identically to the LLM path.
//
// Contract:
//   - Always lowercased + accent-stripped before matching.
//   - Returns `{ productText }` — the raw fragment after the keyword.
//     Executor runs the canonical matcher; on miss it answers
//     deterministically ("No encontré X en tu catálogo.") without LLM.
//   - Patterns are anchored loosely (no ^/$) so leading interjections
//     ("oye, cuánto stock tengo de X") still match.

import { normalizeForMatching } from "@/lib/normalize";

export interface StockQueryFastPathMatch {
  productText: string;
}

// Patterns that signal a general inventory summary query — no specific product.
// Matched BEFORE product-scoped patterns so they never fall through to the LLM.
//
// IMPORTANT: the bare `/\b(?:el\s+)?stock\s*$/i` pattern was intentionally
// REMOVED. It matched "fernet stock", "birras stock" etc. — which are
// product-scoped stock queries, not general summaries. The product name
// appears BEFORE "stock" as a postposed modifier (very common in AR speech/STT).
// Those phrases must fall through to `detectStockQueryFastPath` below, which
// has a "NAME stock" pattern and routes them correctly. General summary is
// now covered by the remaining specific patterns.
const INVENTORY_SUMMARY_PATTERNS: RegExp[] = [
  /\bcu[aá]nto\s+stock\s+(?:tengo|hay|tiene)\b/i,
  /\bcu[aá]nto\s+tengo\s+en\s+stock\b/i,
  /\bcu[aá]l\s+es\s+mi\s+stock\b/i,
  /\bc[oó]mo\s+est[aá]\s+(?:el\s+)?stock\b/i,
  /\bstock\s+total\b/i,
  /\bver\s+(?:el\s+)?stock\b/i,
  /\bmostra(?:me)?\s+(?:el\s+)?stock\b/i,
  // Verb variants mirrored from INVENTORY_WIDE_PATTERNS in intent-handlers/business-query.ts
  // (lines 26-29). Those exist in the post-LLM path; these eliminate the LLM round-trip
  // by catching them in the pre-LLM fast-path. Audit ref: Bug 2 / NLU comprehension audit
  // agent ab2c390e63637a524 (2026-05-28). Source: adk.dev/graphs/ Layer 1 expansion.
  /\bdame\s+(?:el\s+)?(?:stock|inventario)\b/i,
  /\bdecime\s+(?:el\s+)?(?:stock|inventario)\b/i,
  /\blista\s+(?:de\s+)?(?:stock|inventario)\b/i,
  /\bqu[eé]\s+hay\s+(?:en\s+)?(?:stock|inventario)\b/i,
  /\bfijate\s+(?:el\s+)?(?:stock|inventario)\b/i,
  // "el stock" / "stock" alone (no product token before it).
  // Negative lookbehind: reject when a non-article word precedes "stock"
  // within the same phrase — that word is the product (e.g. "fernet stock").
  /^(?:(?:el|la|los|las|mi|nuestro|nuestros)\s+)?stock\s*$/i,
  /\bqu[eé]\s+tengo\s+(?:de\s+)?stock\b/i,
  // "qué inventario tengo" / "cuál es mi inventario" — covers "inventario" without "stock".
  /\bqu[eé]\s+inventario\s+tengo\b/i,
  /\bcu[aá]l\s+es\s+mi\s+inventario\b/i,
  /\bver\s+(?:el\s+)?inventario\b/i,
  /\bmostra(?:me)?\s+(?:el\s+)?inventario\b/i,
  // Low-stock report phrasings — "which products have low stock / are running out".
  // These are general inventory-health queries, NOT queries about a specific product.
  // Without this, the "NAME stock" pattern (pattern 6 below) extracts the whole
  // question as a fake product name (e.g. "cuales son mis productos con menos").
  // Bug: live eval 2026-06-02 — "cuáles son mis productos con menos stock" fell
  // through to stock_query with productText="cuales son mis productos con menos".
  // Source: same INVENTORY_WIDE_PATTERNS expansion as the verb variants above.
  /\bproductos?\s+(?:con\s+)?(?:menos|poco|bajo|bajos?)\s+stock\b/i,
  /\bcu[aá]les?\s+(?:son\s+)?(?:mis\s+|los\s+)?productos?\s+con\s+menos\b/i,
  /\bproductos?\s+(?:bajos?|con\s+poco)\b/i,
  /\bcu[aá]l(?:es)?\s+(?:es|son)\s+(?:el|los)\s+(?:producto|art[ií]culo)\w*\s+con\s+menos\b/i,
  /\bqu[eé]\s+(?:hay\s+que\s+|tengo\s+que\s+|debo\s+)?reponer\b/i,
  /\bqu[eé]\s+(?:me\s+)?falta\s+(?:reponer|pedir|comprar)\b/i,
  /\bproductos?\s+(?:por|para|a\s+punto\s+de)\s+agotarse\b/i,
  /\bqu[eé]\s+(?:productos?\s+)?(?:se\s+)?(?:est[aá]n?\s+)?por\s+agotarse\b/i,
];

export function detectStockSummaryFastPath(text: string): boolean {
  if (!text || text.trim().length === 0) return false;
  const normalized = normalizeForMatching(text).replace(/\s+/g, " ").trim();
  return INVENTORY_SUMMARY_PATTERNS.some((re) => re.test(normalized));
}

// Patterns ordered most-specific-first. Each one MUST end with a
// product fragment (group 1) — questions without a target ("cuánto
// stock tengo") return null and fall through to the LLM (which can
// answer with the full inventory summary).
const PATTERNS: RegExp[] = [
  // "cuánto/cuánta stock tengo de NAME"
  /\bcu[aá]nt[oa]s?\s+stock\s+(?:tengo|hay|queda|me\s+queda|nos\s+queda)\s+de\s+(.+?)\s*\??\s*$/i,
  // "cuántas/cuántos unidades tengo de NAME"
  /\bcu[aá]nt[oa]s?\s+(?:unidades?|u\.?)\s+(?:tengo|hay|queda|me\s+queda|nos\s+queda)\s+de\s+(.+?)\s*\??\s*$/i,
  // "stock de NAME"
  /\bstock\s+(?:de|del)\s+(.+?)\s*\??\s*$/i,
  // "tengo NAME en stock?" / "tengo NAME disponible?"
  /\btengo\s+(.+?)\s+(?:en\s+stock|disponible)\s*\??\s*$/i,
  // "hay stock de NAME?"
  /\bhay\s+stock\s+de\s+(.+?)\s*\??\s*$/i,
  // "inventario de NAME?"
  /\binventario\s+(?:de|del)\s+(.+?)\s*\??\s*$/i,
  // "fernet stock" / "birras stock" — AR postposed modifier (product before "stock").
  // Common in STT and typed shortcuts. Requires at least one non-article word
  // before "stock" — those words are the product name.
  /^(?:(?:el|la|los|las|un|una)\s+)?(.+?)\s+stock\s*\??\s*$/i,
  // "cuántas tuercas tengo?" / "cuántos destornilladores hay?" / "cuántos tornillos quedan?"
  // Product name precedes the verb — no "de" separator. Must follow the
  // "de NAME" patterns above to avoid double-matching them.
  /\bcu[aá]nt[oa]s?\s+(.+?)\s+(?:tengo|hay|quedan?|me\s+quedan?|nos\s+quedan?|te\s+quedan?)\s*\??\s*$/i,
];

// Reject the pure inventory-summary asks — those belong to the LLM /
// business-query post-handler which renders the full catalog table.
// We only want to Fast-Path queries that target a specific product.
const INVENTORY_SUMMARY_RE = /\b(?:todo|completo|general|del?\s+negocio|de\s+todos?|del?\s+local)\b/i;

// Any phrase containing a stock-LOAD verb must NEVER match as a query.
// This guards against patterns like "agrega al stock 10 alfajor" falling
// through to the "NAME stock" pattern when stock_load fast-path fails for
// any reason. The negative pre-check is the last line of defense.
const LOAD_VERB_RE =
  /\b(?:agregar?|agregues?|agrega(?:mos|ron)?|sumar?|sumes?|suma(?:mos|ron)?|cargar?|cargues?|carga(?:mos|ron)?|meter?|metes?|poner?|pones?|recibir?|recibi(?:mos|ste|o)?|llegaron|entraron|compr\w*)\b/i;

// Phrases that describe multiple products by stock level ("productos con menos stock",
// "cuáles son mis productos con menos stock", "productos bajos de stock") are
// inventory-health queries, not queries for a single product. Without this guard,
// the "NAME stock" catch-all pattern (pattern 6) extracts the whole question as a
// fake product name — e.g. "cuales son mis productos con menos".
// Bug: live eval 2026-06-02. These phrasings are also caught by INVENTORY_SUMMARY_PATTERNS
// (defense-in-depth): if the summary fast-path is somehow skipped, this guard is the
// last line of defense inside the product-query detector.
const LOW_STOCK_REPORT_RE =
  /\bproductos?\s+(?:con\s+)?(?:menos|poco|bajo|bajos?)\b|\bproductos?\s+(?:bajos?|por\s+agotarse)\b|\bcu[aá]les?\s+(?:son\s+)?(?:mis\s+|los\s+)?productos?\b/i;

export function detectStockQueryFastPath(text: string): StockQueryFastPathMatch | null {
  if (!text || text.trim().length === 0) return null;
  const normalized = normalizeForMatching(text).replace(/\s+/g, " ").trim();
  if (INVENTORY_SUMMARY_RE.test(normalized)) return null;
  // Bail out immediately if the phrase contains any stock-load verb — it's a
  // mutation intent, not a read query. Let stock_load fast-path (or LLM) handle it.
  if (LOAD_VERB_RE.test(normalized)) return null;
  // Bail out for multi-product low-stock report phrases — these are inventory-health
  // queries ("which products are running low?") that cannot name a specific product.
  // Routed to stock_summary or Supervisor LLM for a list-style response.
  if (LOW_STOCK_REPORT_RE.test(normalized)) return null;

  for (const pattern of PATTERNS) {
    const m = normalized.match(pattern);
    if (!m) continue;
    const productText = (m[1] ?? "")
      .trim()
      .replace(/^(?:el|la|los|las|un|una|unos|unas)\s+/i, "")
      .replace(/[,.;:?!]+$/g, "")
      .trim();
    if (!productText || productText.length < 2) continue;
    return { productText };
  }

  return null;
}
