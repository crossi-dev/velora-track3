// Wrappers for the two table entries in detect.ts that require multi-step
// inline logic (sale_send and sale_create). Extracted to keep detect.ts
// under the 300-line contract.

import { detectSaleCreateFastPath } from "./sale-create-fast-path";
import { containsSendKeyword } from "@/lib/sale-send-detection";
import { extractSaleEntities } from "../extract-sale-entities";
import { normalizeForMatching } from "../shared";
import { hasInvoiceReference } from "../handlers/invoice-reference";
import type { DeterministicIntent } from "./types";
import type { NluContext } from "./detect";

// Audit ref: Bug 1 + Gap 14 — NLU comprehension audit 2026-05-28 (agent ab2c390e63637a524).
// "mandale" is a send keyword in sale-send-detection.ts but was missing here, so the
// AND-gate (SALE_KEYWORDS && containsSendKeyword) always failed for "mandale el comprobante".
// "vendile" is already in SALE_VERB_RE (sale-create-fast-path.ts:85) but was missing here.
// "mandele" is the él/ella 3rd-person variant of "mandale" (AR voseo → él form).
const SALE_KEYWORDS = /\b(vendi|vende|vender|vendele|vendile|cobrale|venta|factura|mandale|mandele)\b/;

// Quantity extraction — mirrors sale-create-fast-path.ts logic.
const QTY_RE = /\b(\d{1,4})\s+/;
const UNIT_PRICE_EXPLICIT_RE = /\b(?:a|cada\s+una?)\s+\$?\s*(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d+)?)\s*(?:pesos?|\$|cada\s+una?|la\s+unidad)?\b/i;
const PRICE_RE = /\b(?:a|cada\s+una?|por)\s+\$?\s*(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d+)?)\s*(?:pesos?|\$|cada\s+una?|la\s+unidad)?\b/i;
const SPANISH_QTY: Record<string, number> = {
  dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6,
  siete: 7, ocho: 8, nueve: 9, diez: 10,
};

function extractQty(normalized: string): number {
  const qtyMatch = normalized.match(QTY_RE);
  if (qtyMatch && qtyMatch.index !== undefined) {
    const candidate = Number.parseInt(qtyMatch[1], 10);
    if (Number.isFinite(candidate) && candidate >= 1 && candidate < 10000) {
      const priceMatchExec =
        UNIT_PRICE_EXPLICIT_RE.exec(normalized) ??
        PRICE_RE.exec(normalized);
      const digitIsInsidePrice =
        priceMatchExec !== null &&
        priceMatchExec.index !== undefined &&
        qtyMatch.index >= priceMatchExec.index;
      if (!digitIsInsidePrice) return candidate;
    }
  }
  const wordMatch = normalized.match(/\b(dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)\b/);
  if (wordMatch?.[1]) return SPANISH_QTY[wordMatch[1]] ?? 1;
  return 1;
}

// Step 4 — sale_send: sale verb + send keyword in same turn.
// NLU resolves catalog matches (Fast Path); dispatcher decides LLM fallback.
export function detectSaleSendFastPath(text: string, ctx: NluContext): DeterministicIntent | null {
  const normalized = normalizeForMatching(text);
  if (!SALE_KEYWORDS.test(normalized) || !containsSendKeyword(normalized)) return null;
  // C1 fix — JD adversarial review Step 1, 2026-05-28.
  // "mandale" is in SALE_KEYWORDS (Bug 1 fix) which causes "mandale el comprobante
  // a Juan" to be intercepted here before the invoice handler (label 9) can fire.
  // Early-bailout: if the text references an invoice artifact (factura/comprobante/
  // recibo), this is an invoice-send turn — return null so label 9 handles it.
  if (hasInvoiceReference(normalized)) return null;
  const entities = extractSaleEntities(text, ctx.catalog.products, ctx.catalog.customers);
  const matchedProductId = entities.product.match?.id ?? null;
  const matchedCustomerId = entities.customer.match?.id ?? null;
  const productName = entities.product.match?.name ?? "";
  const needsLlmFallback =
    (!matchedProductId && !entities.product.ambiguous) ||
    (!matchedCustomerId && !entities.customer.ambiguous);
  const qty = extractQty(normalized);
  return {
    kind: "sale_send",
    matchedProductId,
    matchedCustomerId,
    productName,
    productAmbiguous: entities.product.ambiguous,
    customerAmbiguous: entities.customer.ambiguous,
    needsLlmFallback,
    qty,
    // Carry candidates so the executor can show a deterministic picker instead
    // of calling the LLM when the match was ambiguous (2+ close catalog scores).
    // Ref: cloud.google.com/blog/products/ai-machine-learning/how-to-design-conversational-ai-agents
    // — "when a query is ambiguous, the agent should ask clarifying questions / offer options."
    ...(entities.product.ambiguous && entities.product.candidates
      ? { productCandidates: entities.product.candidates.map((c) => ({ id: c.id, name: c.name })) }
      : {}),
    ...(entities.customer.ambiguous && entities.customer.candidates
      ? { customerCandidates: entities.customer.candidates.map((c) => ({ id: c.id, name: c.name })) }
      : {}),
  };
}

// Step 4b — sale_create: plain sale (no send keyword). Conservative: requires
// product resolved without ambiguity. Customer resolution cascade:
//   1. customer resolved from catalog → sale_create (full match)
//   2. text has "a/para [Name] [phone]" → sale_create_inline_new_customer
//   3. catalog has customers but none resolved → sale_create_pending_customer (picker)
export function detectSaleCreateComposite(text: string, ctx: NluContext): DeterministicIntent | null {
  const result = detectSaleCreateFastPath(text, ctx.catalog);
  if (!result) return null;
  if ("kind" in result && result.kind === "inline_new_customer") {
    return {
      kind: "sale_create_inline_new_customer",
      matchedProductId: result.matchedProductId,
      productName: result.productName,
      qty: result.qty,
      unitPrice: result.unitPrice,
      newCustomerName: result.newCustomerName,
      newCustomerPhone: result.newCustomerPhone,
    };
  }
  if ("kind" in result && result.kind === "pending_customer") {
    return {
      kind: "sale_create_pending_customer",
      matchedProductId: result.matchedProductId,
      productName: result.productName,
      qty: result.qty,
      unitPrice: result.unitPrice,
    };
  }
  // TypeScript narrowing: when kind is not "pending_customer" or "inline_new_customer",
  // the match is a full SaleCreateFastPathMatch with matchedCustomerId.
  const full = result as import("./sale-create-fast-path").SaleCreateFastPathMatch;
  return {
    kind: "sale_create",
    matchedProductId: full.matchedProductId,
    matchedCustomerId: full.matchedCustomerId,
    productName: full.productName,
    customerName: full.customerName,
    qty: full.qty,
    unitPrice: full.unitPrice,
  };
}
