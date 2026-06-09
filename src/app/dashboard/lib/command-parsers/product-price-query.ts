import { tLang } from "../DashboardLangContext";
import {
  cleanProductName,
  resolveProductName,
  type ProductCatalogItem,
  type VeloraSingleCommand,
} from "./shared";

// Request-style prefixes eaten before pattern match so "decime cuánto
// vale la yerba" / "dame el precio de X" reach the same patterns as
// the bare forms.
const REQUEST_PREFIX_RE =
  /^(?:decime|deci|dime|dame|mostrame|mostra|fijate|a\s+ver)\s+(?:el\s+|la\s+|los\s+|las\s+|un\s+|una\s+)?/;

// Leading article stripped from the captured fragment so the fuzzy
// matcher gets a clean product name.
const CAPTURE_ARTICLE_RE = /^(?:el|la|los|las|un|una|lo)\s+/;

// Patterns capturing the product fragment after a price-query verb.
// Order matters — more specific first. Question mark is optional so
// SpeechRecognition transcripts (no punctuation) also match.
const PRICE_QUERY_PATTERNS: RegExp[] = [
  // "cuánto vale / cuesta / sale (la) yerba"
  /^(?:a\s+)?cuanto\s+(?:vale|valen|cuesta|cuestan|sale|salen)\s+(.+?)\??$/,
  // "a qué precio está / sale / vale la yerba"
  /^a\s+que\s+(?:precio|valor)\s+(?:esta|sale|vale|estan|salen|valen)\s+(.+?)\??$/,
  // "qué / cuál precio tiene la yerba"
  /^(?:que|cual)\s+(?:precio|valor)\s+tiene\s+(.+?)\??$/,
  // "cuál es el precio de la yerba" / "precio de la yerba" / "precio yerba"
  /^(?:cual\s+es\s+)?(?:el\s+)?precio\s+(?:de\s+)?(.+?)\??$/,
  // "valor de la yerba" / "valor yerba"
  /^valor\s+(?:de\s+)?(.+?)\??$/,
];

export interface ProductPriceQueryData {
  productName: string;
  productId: string | null;
}

export function detectProductPriceQuery(
  normalized: string,
  products: ProductCatalogItem[]
): VeloraSingleCommand | null {
  // normalizeForMatching preserves inverted punctuation ("¿", "¡").
  // Strip it here so the `^` anchors match for typed inputs that include
  // Spanish opening marks. SpeechRecognition output rarely has them.
  const cleaned = normalized.replace(/^[¿¡]+\s*/, "").trim();
  const stripped = cleaned.replace(REQUEST_PREFIX_RE, "").trim();
  const candidates = stripped && stripped !== cleaned ? [stripped, cleaned] : [cleaned];

  for (const text of candidates) {
    for (const pattern of PRICE_QUERY_PATTERNS) {
      const m = text.match(pattern);
      if (!m) continue;
      const fragment = m[1].trim().replace(CAPTURE_ARTICLE_RE, "");
      const productName = cleanProductName(fragment);
      if (!productName || productName.length < 2) continue;
      const productMatch = resolveProductName(productName, products);
      return {
        matched: true,
        intent: "product_price_query",
        data: {
          productName,
          productId: productMatch?.id ?? null,
        },
      };
    }
  }
  return null;
}

// ── Reply builders (pure, exported for testing) ────────────────────

export function buildProductPriceReply(
  productName: string,
  price: number,
  currency: string
): string {
  const fmt = new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: currency || "ARS",
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
  return tLang(`${productName} is ${fmt.format(price)}.`, `${productName} vale ${fmt.format(price)}.`);
}

export function buildProductPriceNotFoundReply(query: string): string {
  return tLang(`Could not find "${query}" in your catalog. Check the name or add the product first.`, `No encontré "${query}" en tu catálogo. Revisá el nombre o cargá el producto primero.`);
}
