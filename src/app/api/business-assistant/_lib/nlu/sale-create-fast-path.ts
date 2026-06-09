// sale_create Fast Path detector — keeps PLAIN sale creation off the
// Gemini Pro Slow Path (~30s cross-region). Companion to sale_send: this
// one fires when the user wants to register a sale WITHOUT auto-sending
// the WhatsApp summary. The smoke harness measured 32s end-to-end for
// "vendí 2 lapiceras a María por 500" via the supervisor.
//
// Scope intentionally narrow — patterns require:
//   1. An explicit sale verb (`vendi`/`vendele`/`venta de`).
//   2. A resolvable product from the catalog (via extractSaleEntities).
//   3. A resolvable customer from the catalog (same).
//   4. Optional quantity + price; both default to catalog price/1 if absent.
//
// Conservative — if EITHER product or customer is missing/ambiguous, we
// fall through to the LLM. False-negatives (LLM fallback) are fine;
// false-positives (wrong customer in a sale) are catastrophic — they hit
// the audit log + idempotency contract before the user can react.
//
// Contract:
//   - Always lowercased + accent-stripped before matching.
//   - Returns `{ matchedProductId, matchedCustomerId, productName, qty, unitPrice }`.
//   - Executor builds a saleDraft + emits register_sale action (NO autoSend).
//   - Patterns anchored loosely (no ^/$) so interjections still match.

import { normalizeForMatching } from "@/lib/normalize";
import { containsSendKeyword } from "@/lib/sale-send-detection";
import { parseSpanishNumber } from "@/lib/word-to-number";
import { parseARAmount } from "@/lib/parse-ar-amount";
import { extractSaleEntities } from "../extract-sale-entities";
import {
  detectInlineNewCustomer,
  type SaleCreateInlineNewCustomerMatch,
} from "./sale-create-inline-customer-match";

export type { SaleCreateInlineNewCustomerMatch } from "./sale-create-inline-customer-match";
export { normalizeArgPhone } from "./sale-create-inline-customer-match";

export interface SaleCreateFastPathMatch {
  kind?: never; // discriminated union tag (absent = full match)
  matchedProductId: string;
  matchedCustomerId: string;
  productName: string;
  customerName: string;
  qty: number;
  unitPrice: number | null; // null = use product's catalog price
}

// Returned when product resolves but customer does NOT. The dispatcher
// shows a customer-picker chip instead of falling to the LLM.
export interface SaleCreatePendingCustomerMatch {
  kind: "pending_customer";
  matchedProductId: string;
  productName: string;
  qty: number;
  unitPrice: number | null;
}

interface DetectorCatalog {
  products: Array<{ id: string; name: string }>;
  customers: Array<{ id: string; name: string }>;
}

// Sale verbs that signal a deterministic create intent. Excludes
// `cobrale` because that's already routed via sale_send. Excludes plain
// `cobro` because that's `cobro_qr`. We require a sale-shaped verb
// AND the absence of a send keyword (`mandale`, `mandala`, etc.) —
// presence of a send keyword means it's a sale_send turn (handled
// earlier in detect.ts).
//
// IMPORTANTE: el regex se evalúa contra texto YA normalizado (lowercased +
// accent-stripped por normalizeForMatching). Por eso `vendé` (voseo
// imperativo, lo que tipean owners argentinos y lo que produce el smoke
// harness) llega como `vende`, y `vendí` llega como `vendi`. Si listás un
// verbo con acento acá NUNCA va a matchear. La omisión de `vende` fue la
// causa de que el smoke "vendé un X a Y" cayera a Slow Path (~8s) en vez
// de ejecutarse sub-segundo. SALE_KEYWORDS en detect.ts ya incluye `vende`
// — esto la alinea.
// "carga" is also a stock-load verb, so it only counts as a sale verb when the
// explicit sale noun "venta" also appears (e.g. "cargá una venta de 3 alfas").
// Bare "cargá 10 cocas" (no "venta") must NOT match here — stock-load owns it.
// "pasame/pasa" are Argentine colloquial hand-off verbs meaning "register this sale".
// pas[ao](?:me|le)? covers pasame, pasale, pasa, paso — Argentine hand-off verbs
// meaning "register this sale". Previously only `pasa`/`pasame`/`paso` matched;
// `pasale` was silently falling through to the LLM slow path.
const SALE_VERB_RE =
  /\b(vendi|vende|vendo|vender|vendele|vendile|venta\s+de|venti|pas[ao](?:me|le)?)\b/;

// Belt-and-suspenders: "carga … venta" — stock-load fast-path already bails
// when "venta" is present, but we also accept the phrase here so that if the
// ordering ever changes the sale detector still wins.
const CARGA_VENTA_RE = /\bcarga(?:r|me|nos|le)?\b.*\bventa\b/;

// "hacele la venta a Juan" — AR imperative for sale creation. Gated on the
// presence of "venta" to avoid false-fires on "hacele un café". Gap 6 — NLU
// comprehension audit 2026-05-28 (agent ab2c390e63637a524).
//
// M1 fix — JD adversarial review Step 1, 2026-05-28.
// Original: /\bhac[eé](?:le|me)?\b.*\bventa\b/ — too loose.
// "hacele un resumen de la venta" and "hace cuanto fue la venta" both match
// even though they are queries, not sale-create commands.
// Fix: require a directional preposition (a/de/al/para) to appear AFTER "venta".
// This excludes "resumen de la venta" and "cuanto fue". Exported for unit tests.
export const HACELE_VENTA_RE =
  /\bhac[eé](?:le|me)?\b.{0,30}\bventa\s+(?:a|de|al?|para)\b/i;

// "cobré N producto" — Argentine slang for a sale where no customer is
// stated and the verb "cobré" precedes a quantity and product name.
// Distinct from cobro_qr (which requires a digit-only amount but no product name).
// This pattern triggers pending_customer flow (no "pa/para customer" present).
// Examples: "cobré dos alfajores", "cobre 3 cocas".
const COBRO_SALE_RE = /\bcobr[eoi]\w*\s+(?:\d+|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)\s+\w/;

// Implicit sale pattern: "N [product] pa/para [customer]" — Argentine slang
// shorthand for sale without an explicit sale verb. Requires a number or
// Spanish quantity word so bare "cocas para Juan" (could be a stock query)
// doesn't false-fire. Examples: "tres cocas pa Lucía", "2 panes para María".
const IMPLICIT_SALE_RE =
  /\b(\d{1,4}|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)\s+\w+\s+pa(?:ra)?\s+\w/;

// Permissive shape: optional `qty` + product fragment + `a/para/al`
// + customer fragment + optional `por <price>`.
// We DON'T parse product/customer names from the regex — we let
// extractSaleEntities resolve against the catalog (battle-tested by
// sale_send). The regex is just a gate to confirm shape.

// Quantity extractor — matches a leading "N" before the product fragment.
// Bare "vendi tuerca" defaults qty=1.
const QTY_RE = /\b(\d{1,4})\s+/;

// Price extractor — matches unit-price signals anywhere in the text:
//   "a 200", "a $200", "a 200 cada una", "a 200 la unidad", "cada una 200",
//   "por 500" (near end — may be total when qty>1, heuristic below).
// Group 1 captures the number. Stays loose: $5000, 5.000, 5000 all fine.
const PRICE_RE = /\b(?:a|cada\s+una?|por)\s+\$?\s*(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d+)?)\s*(?:pesos?|\$|cada\s+una?|la\s+unidad)?\b/i;
// "por <number>" near end is the TOTAL pattern for qty>1. We detect
// explicit unit-price markers ("a N", "a $N", "cada una N", "N la unidad")
// to distinguish. The unit-price pattern is checked separately below.
const UNIT_PRICE_EXPLICIT_RE = /\b(?:a|cada\s+una?)\s+\$?\s*(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d+)?)\s*(?:pesos?|\$|cada\s+una?|la\s+unidad)?\b/i;

// Delegates to the canonical AR-amount parser.
// TODO: consolidate qty regex / SPANISH_QTY in a follow-up pass
//       (depends on word-to-number.ts being fully wired).
function parsePrice(raw: string): number | null {
  return parseARAmount(raw);
}

export function detectSaleCreateFastPath(
  text: string,
  catalog: DetectorCatalog,
): SaleCreateFastPathMatch | SaleCreatePendingCustomerMatch | SaleCreateInlineNewCustomerMatch | null {
  if (!text || text.trim().length === 0) return null;
  if (catalog.products.length === 0) return null;

  const normalized = normalizeForMatching(text).replace(/\s+/g, " ").trim();

  // Sale verb required (or implicit sale pattern). If a send keyword is also
  // present, it's a sale_send — let that detector own it (runs earlier in
  // detect.ts anyway).
  const hasSaleVerb = SALE_VERB_RE.test(normalized) || CARGA_VENTA_RE.test(normalized) || HACELE_VENTA_RE.test(normalized);
  const hasImplicitSale = !hasSaleVerb && IMPLICIT_SALE_RE.test(normalized);
  // "cobré dos alfajores" — cobro verb + qty + product, no explicit customer.
  // Triggers pending_customer flow. Distinct from cobro_qr (no digit-only amount).
  const hasCobroSale = !hasSaleVerb && !hasImplicitSale && COBRO_SALE_RE.test(normalized);
  if (!hasSaleVerb && !hasImplicitSale && !hasCobroSale) return null;
  if (containsSendKeyword(normalized)) return null;

  // Resolve product + customer against catalog.
  const entities = extractSaleEntities(text, catalog.products, catalog.customers);
  const product = entities.product.match;
  const customer = entities.customer.match;

  // Product must resolve cleanly — no ambiguity. Without a product we can't
  // build any pending-customer flow either.
  if (!product || entities.product.ambiguous) return null;

  // Customer resolution: if catalog has customers but none resolved → show
  // customer-picker instead of falling to LLM. If no customer catalog at all
  // → fall through (no picker makes sense).
  const hasMissingCustomer =
    catalog.customers.length > 0 &&
    (!customer || entities.customer.ambiguous);

  // Quantity (optional, default 1). Take FIRST integer before the product
  // name appears in the text — the price extractor takes the last "por N".
  // Also handle Spanish number words (dos, tres, once…) common in slang
  // like "tres cocas pa Lucía" or "once alfajores pa Juan" where no digit
  // is present. Delegates to parseSpanishNumber() from @/lib/word-to-number
  // (audit ref: velora/audit/parsing-tanda-1/number-date-parsing) which
  // covers the full 2-29+ range including "once", "par", etc.
  //
  // Guard: reject the QTY_RE match if the digit is located INSIDE a price
  // context (matched by PRICE_RE or UNIT_PRICE_EXPLICIT_RE at the same index).
  // Without this guard "vendé una coca a María por 200" yields qty=200 because
  // QTY_RE grabs the only digit "200" which is actually the price.
  let qty = 1;
  const qtyMatch = normalized.match(QTY_RE);
  if (qtyMatch && qtyMatch.index !== undefined) {
    const candidate = Number.parseInt(qtyMatch[1], 10);
    if (Number.isFinite(candidate) && candidate >= 1 && candidate < 10000) {
      // Check whether the digit found by QTY_RE falls inside the price match.
      // exec() returns index; match() does not.
      const priceMatchExec =
        UNIT_PRICE_EXPLICIT_RE.exec(normalized) ??
        PRICE_RE.exec(normalized);
      const digitIsInsidePrice =
        priceMatchExec !== null &&
        priceMatchExec.index !== undefined &&
        qtyMatch.index >= priceMatchExec.index;
      if (!digitIsInsidePrice) {
        qty = candidate;
      }
    }
  } else {
    // Fall back to Spanish number words via canonical parseSpanishNumber().
    // Covers dos-diez AND once, doce, par, docena, etc. — see @/lib/word-to-number.
    const wordMatch = normalized.match(
      /\b(par|docena|media\s+docena|una\s+mano|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|trece|catorce|quince|diecis(?:e|é)is|diecisiete|dieciocho|diecinueve|veinte|veintiuno|veintid(?:o|ó)s|veintitr(?:e|é)s|veinticuatro|veinticinco)\b/,
    );
    if (wordMatch?.[1]) {
      const parsed = parseSpanishNumber(wordMatch[1]);
      if (parsed !== null && parsed >= 1) qty = parsed;
    }
  }

  // Price (optional, default null → executor uses catalog price).
  //
  // Heuristic for qty>1:
  //   - "a N" / "cada una N" → explicit unit-price marker → ALWAYS use as
  //     unitPrice regardless of qty (user said "vendé 3 a 200").
  //   - "por N" near end → likely a total ("vendí 3 tuercas por 600") →
  //     treat as unitPrice ONLY when qty=1; leave null otherwise so the
  //     confirmation card can surface the ambiguity.
  let unitPrice: number | null = null;
  const explicitUnitMatch = normalized.match(UNIT_PRICE_EXPLICIT_RE);
  if (explicitUnitMatch) {
    const parsed = parsePrice(explicitUnitMatch[1]);
    if (parsed !== null) unitPrice = parsed;
  } else {
    const priceMatch = normalized.match(PRICE_RE);
    if (priceMatch) {
      const parsed = parsePrice(priceMatch[1]);
      if (parsed !== null && qty === 1) unitPrice = parsed;
    }
  }

  // Customer not resolved from catalog (missing or ambiguous). Try inline
  // "a/para [Name] [phone]" parse before falling back to picker chips.
  // Fires regardless of catalog size — empty catalog → no one to match against.
  const customerNotResolved = !customer || entities.customer.ambiguous;
  if (customerNotResolved) {
    const inline = detectInlineNewCustomer(
      text,
      catalog.customers as Array<{ id: string; name: string; phone?: string }>,
    );
    if (inline?.kind === "reuse_existing") {
      return {
        matchedProductId: product.id,
        matchedCustomerId: inline.customerId,
        productName: product.name,
        customerName: inline.customerName,
        qty,
        unitPrice,
      };
    }
    if (inline?.kind === "inline_new_customer") {
      return {
        kind: "inline_new_customer",
        matchedProductId: product.id,
        productName: product.name,
        qty,
        unitPrice,
        newCustomerName: inline.newCustomerName,
        newCustomerPhone: inline.newCustomerPhone,
      };
    }
    // No valid name+phone found. Show picker chips when catalog has customers.
    if (hasMissingCustomer) {
      return {
        kind: "pending_customer",
        matchedProductId: product.id,
        productName: product.name,
        qty,
        unitPrice,
      };
    }
    return null;
  }

  // Both product and customer resolved → full fast-path sale.
  if (!customer) return null; // should not happen at this point, but guard type
  return {
    matchedProductId: product.id,
    matchedCustomerId: customer.id,
    productName: product.name,
    customerName: customer.name,
    qty,
    unitPrice,
  };
}
