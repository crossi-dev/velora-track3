// price-query Fast Path detector — deterministic handler for product price
// and stock queries like "¿cuánto sale la coca?" / "precio del pan".
//
// Promotes the old productQueryRescueStage (post-LLM) to pre-LLM so simple
// price/stock queries skip Gemini Flash entirely (~3-5s latency, 4/5 parse
// fail rate on these queries confirmed by isolate-retry 2026-05-10).
//
// Contract:
//   - Runs BEFORE model invocation (Phase.PreModelDeterministic).
//   - Requires productInfoDirectory to be non-empty (checked in detect.ts).
//   - Returns `{ queryKind, productText }` on match, null otherwise.
//   - Executor resolves the product with findProductInfoMatch; on miss it
//     answers deterministically ("No encontré X") without LLM.

import { normalizeForMatching } from "@/lib/normalize";
import { PRICE_QUERY_RE, STOCK_QUERY_RE } from "./query-regex";

export type PriceQueryKind = "price" | "stock";

export interface PriceQueryFastPathMatch {
  queryKind: PriceQueryKind;
  productText: string;
}

// Patterns that identify a product-scoped price/stock query.
// Group 1 captures the product fragment.
const PRICE_PATTERNS: RegExp[] = [
  // "cuánto sale/vale/cuesta X"
  /\bcu[aá]nto\s+(?:sale|vale|cuesta)\s+(?:el|la|los|las|un|una)?\s*(.+?)\s*\??\s*$/i,
  // "cuánto está el fernet" / "a cuánto está X" — AR canonical price ask
  /\b(?:a\s+)?cu[aá]nto\s+esta\s+(?:el|la|los|las|un|una)?\s*(.+?)\s*\??\s*$/i,
  // "precio de X" / "el precio del X"
  /\bprecio\s+(?:de(?:l?|la)?)\s+(.+?)\s*\??\s*$/i,
  // "cuánto cuesta X" / "cuánto vale X"
  /\bcu[aá]nto\s+(?:cuesta|vale|valen|cuestan|salen)\s+(?:el|la|los|las|un|una)?\s*(.+?)\s*\??\s*$/i,
  // "X cuánto sale/vale?"
  /^(.+?)\s+cu[aá]nto\s+(?:sale|vale|cuesta)\s*\??$/i,
  // "el precio de X"
  /\bel\s+precio\s+(?:de(?:l?|la)?)\s+(.+?)\s*\??\s*$/i,
];

const STOCK_PATTERNS: RegExp[] = [
  // "cuánto stock de X"
  /\bcu[aá]ntos?\s+(?:tengo|hay|queda|me\s+queda|nos\s+queda)\s+de\s+(.+?)\s*\??\s*$/i,
  // "hay X disponible?" / "tengo X?"
  /\b(?:hay|tengo)\s+(.+?)\s+(?:disponible|en\s+stock)\s*\??\s*$/i,
];

// Reject ambiguous wide-inventory asks — those belong to business_query.
const WIDE_INVENTORY_RE = /\b(?:todo|todos?\s+los?\s+productos?|inventario\s+completo|completo)\b/i;

// Mutation-verb guard: these verbs signal a price EDIT, not a price QUERY.
// When present, skip this fast path so the Pro Supervisor handles the mutation
// structurally (owner single-price-edit route) or so single_price_edit fires
// for employees (label 6 in detect.ts PRIORITY_TABLE).
// Without this, "cambia el precio de tuercas a 80" triggers the "precio de X"
// PRICE_PATTERNS pattern and is misclassified as price_query.
const PRICE_MUTATION_VERB_RE =
  /\b(?:cambia|cambi[ao]|cambiale|cambia(?:lo|la|les?)?|actualiza|actualiz[ao]|ponele?|pon(?:e(?:le?)?)?|baj[ao]|baj[ao](?:le)?|sub[io]|sub[io](?:le)?|dej[ao]|que\s+sea|que\s+valga|pasa(?:le)?)\b/;

export function detectPriceQueryFastPath(text: string): PriceQueryFastPathMatch | null {
  if (!text || text.trim().length === 0) return null;

  const normalized = normalizeForMatching(text).replace(/\s+/g, " ").trim();
  if (WIDE_INVENTORY_RE.test(normalized)) return null;
  // Bail out for price mutation commands — those go to the Pro Supervisor or
  // the single_price_edit deterministic path, not the query responder.
  if (PRICE_MUTATION_VERB_RE.test(normalized)) return null;

  const isPriceSignal = PRICE_QUERY_RE.test(normalized);
  const isStockSignal = !isPriceSignal && STOCK_QUERY_RE.test(normalized);

  if (!isPriceSignal && !isStockSignal) return null;

  const patterns = isPriceSignal ? PRICE_PATTERNS : STOCK_PATTERNS;

  for (const pattern of patterns) {
    const m = normalized.match(pattern);
    if (!m) continue;
    const raw = (m[1] ?? "")
      .trim()
      .replace(/^(?:el|la|los|las|un|una|unos|unas)\s+/i, "")
      .replace(/[,.;:?!]+$/g, "")
      .trim();
    if (!raw || raw.length < 2) continue;
    return { queryKind: isPriceSignal ? "price" : "stock", productText: raw };
  }

  return null;
}
