import "server-only";
// customer-agent-nostock-guard.ts — Post-reply hallucination guard for no-stock claims.
//
// Flash is non-deterministic: ~1-in-N turns it skips the get_catalog tool call and
// replies with a false "no tengo / no me queda / no hay" for a product that IS in
// the catalog with stock > 0.
//
// This guard is a DETERMINISTIC backstop — it runs after finalText is produced and
// before it is returned. If it detects a false no-stock claim, it replaces the reply
// with a catalog-grounded affirmative line and logs the event.
//
// Design:
//   1. Parse the catalog snapshot (already fetched from DB) → products with stock > 0.
//   2. Detect no-stock phrases in finalText (case-insensitive).
//   3. Fuzzy-match each in-stock product name against the user's last message.
//   4. If a match is found → it's a hallucination. Replace reply + log.
//
// Safety:
//   - Guard ONLY fires when catalog shows stock > 0 for a matched product.
//   - When quantity === 0, the "no stock" reply is correct — guard stays silent.
//   - When no catalog product matches the user message, guard stays silent (avoids
//     false positives for products not in the snapshot yet).
//
// Source: the catalog summary format is defined in customer-agent-catalog.ts:
//   "ProductName: $price (N en stock) [productId:xxx]"
//   "(catálogo vacío — usá get_catalog para verificar)" when empty

import { cloudLog } from "@/lib/cloud-logger";

// Phrases that indicate the agent is claiming no stock / unavailability.
// Lowercase — matched against finalText.toLowerCase().
const NO_STOCK_PHRASES = [
  "no me quedan",
  "no me queda",
  "no tengo",
  "no hay",
  "sin stock",
  "no contamos",
  "agotado",
  "agotada",
  "no disponible",
  "no está disponible",
  "no tenemos",
];

// Minimum fraction of significant words from a product name that must match
// in the user message for a fuzzy hit. Set to 0.5 so a 2-word product like
// "Alfajor Chocolate" matches when only "alfajor" appears in the user message.
// The threshold still prevents false positives from very short stop words.
const FUZZY_MATCH_THRESHOLD = 0.5;

/** A parsed in-stock product from the catalog snapshot. */
interface InStockProduct {
  name: string;
  stock: number;
  price: number;
}

/**
 * Parse the catalog summary string into a list of in-stock products.
 * The format per line is:
 *   "ProductName: $price (N en stock) [productId:xxx]"
 * or truncation marker:
 *   "... (catálogo truncado — usá get_catalog para ver más)"
 * or placeholder strings (empty catalog, error).
 */
export function parseInStockProducts(catalogSummary: string): InStockProduct[] {
  if (!catalogSummary || catalogSummary.startsWith("(")) return [];
  const result: InStockProduct[] = [];
  for (const line of catalogSummary.split("\n")) {
    if (line.startsWith("...")) continue;
    // Pattern: "Name: $price (N en stock) [productId:xxx]"
    const m = line.match(/^(.+?):\s*\$(\d+(?:\.\d+)?)\s*\((\d+)\s*en stock\)/);
    if (!m) continue;
    const stock = parseInt(m[3], 10);
    if (stock > 0) {
      result.push({ name: m[1].trim(), stock, price: parseFloat(m[2]) });
    }
  }
  return result;
}

/**
 * Fuzzy match: returns true if enough significant words from productName
 * appear in the user message with word-boundary awareness.
 *
 * Match strategy (two passes, both require word boundaries to avoid false positives
 * like "no hay agua caliente" matching product "Agua" via substring):
 *   Pass 1 — product word appears as a whole token in the message
 *             (e.g., "alfajor" in "quiero alfajores?" — "alfajores" starts with "alfajor" ✓)
 *   Pass 2 — message word starts with the product word (handles plural/inflection)
 *             e.g., productWord="alfajor", messageWord="alfajores" → alfajores.startsWith("alfajor") ✓
 *
 * "Significant" = word length > 3 (filters "de", "la", "el", "los", "hay", etc.
 *   — raised from >2 to reduce false positives on 3-char common words like "hay").
 */
function productMentionedInMessage(productName: string, userMessage: string): boolean {
  const msgLower = userMessage.toLowerCase();
  // Tokenize message into word-boundary-safe tokens for reverse match
  const msgWords = msgLower.split(/\s+/).filter((w) => w.length > 3);
  const productWords = productName.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
  if (!productWords.length) return false;
  const matched = productWords.filter((pw) => {
    // Pass 1: product word appears at a word boundary in the message
    // \b matches between \w and \W — handles "alfajor" in "alfajores" because
    // "alfajores" starts with "alfajor" and the boundary is after the "r".
    // Using startsWith match on message tokens is cleaner and avoids regex special chars.
    if (msgWords.some((mw) => mw === pw || mw.startsWith(pw))) return true;
    // Pass 2: product word starts with a message word (message uses longer form).
    // e.g., productWord="facturas", messageWord="factura" → "facturas".startsWith("factura") ✓
    if (msgWords.some((mw) => pw.startsWith(mw) && mw.length > 3)) return true;
    return false;
  }).length;
  return matched / productWords.length >= FUZZY_MATCH_THRESHOLD;
}

/**
 * Returns true if the reply contains a no-stock denial phrase.
 */
function replyDeniesStock(reply: string): boolean {
  const lower = reply.toLowerCase();
  return NO_STOCK_PHRASES.some((phrase) => lower.includes(phrase));
}

export interface NoStockGuardResult {
  /** The final text to use — either original (no hallucination) or replacement. */
  text: string;
  /** True when the guard fired and replaced the reply. */
  fired: boolean;
}

/**
 * Run the no-stock hallucination guard.
 *
 * @param finalText    The reply produced by the Customer Agent.
 * @param catalogSummary  The catalog snapshot injected into the instruction.
 * @param userMessage  The user's last message (used for product name matching).
 * @param businessId   For logging context.
 * @param customerPhone  For logging context.
 */
export function applyNoStockGuard(
  finalText: string,
  catalogSummary: string,
  userMessage: string,
  businessId: string,
  customerPhone: string,
): NoStockGuardResult {
  // Fast exit: no denial in the reply → nothing to guard.
  if (!replyDeniesStock(finalText)) return { text: finalText, fired: false };

  const inStock = parseInStockProducts(catalogSummary);
  // Fast exit: empty catalog or all products at zero — denial may be correct.
  if (!inStock.length) return { text: finalText, fired: false };

  const matched = inStock.find((p) => productMentionedInMessage(p.name, userMessage));
  if (!matched) return { text: finalText, fired: false };

  // Hallucination confirmed: the catalog shows stock > 0 for a product the
  // user asked about, but the agent denied availability.
  cloudLog({
    severity: "WARNING",
    component: "CustomerAgent",
    action: "CUSTOMER_AGENT_NOSTOCK_HALLUCINATION_GUARD",
    a2a_transfer: false,
    message: `No-stock hallucination detected and corrected for product "${matched.name}" (stock=${matched.stock})`,
    data: { businessId, customerPhone, product: matched.name, stock: matched.stock, originalReply: finalText },
  });

  // Neutral availability confirmation — does not presume intent to buy right now.
  // Softer than "¿Cuántas querés?" which is pushy when the customer is browsing.
  const corrected = `Sí, tenemos ${matched.name} disponible ($${matched.price} c/u). ¿Te puedo ayudar con algo?`;
  return { text: corrected, fired: true };
}
