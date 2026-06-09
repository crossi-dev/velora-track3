// sub-agent-hallucination-guard.checks.ts
//
// Per-agent catalog check functions and ID/name extractors for the
// sub-agent hallucination guard. Kept in a sibling file so the main
// guard module stays under the 300-line server/api size contract.
//
// Do NOT import this file directly — consume it via
// sub-agent-hallucination-guard.ts.

import type { AgentGuardCatalog } from "./sub-agent-hallucination-guard";
import { normalizeForMatching } from "@/lib/normalize";

// ── Text normalizer ──────────────────────────────────────────────────────────
// Delegates to the canonical normalizeForMatching (NFKC→NFD→\p{M}→lowercase).
// Thin wrapper that also trims — callers in this file expect trimmed output.

export function normalize(s: string): string {
  return normalizeForMatching(s.trim());
}

// ── Catalog match helper ──────────────────────────────────────────────────────
/**
 * Returns true when `candidate` is a plausible mention of one of the catalog
 * values. Uses normalized prefix / substring match — intentionally liberal to
 * avoid false positives on LLM paraphrasing (e.g. "pi_abc" → "pi_abc123").
 * An empty catalog means no constraint (returns true for all candidates).
 */
export function mentionMatchesCatalog(candidate: string, catalog: string[]): boolean {
  if (catalog.length === 0) return true;
  const cn = normalize(candidate);
  return catalog.some((entry) => {
    const en = normalize(entry);
    return cn === en || en.includes(cn) || cn.includes(en);
  });
}

// ── ID extraction helpers ────────────────────────────────────────────────────

// Payments: bare "pi_<id>" patterns in free text.
const PAYMENT_INTENT_ID_RE = /\bpi_[A-Za-z0-9_-]+/g;
export function extractPaymentIntentMentions(text: string): string[] {
  return [...text.matchAll(PAYMENT_INTENT_ID_RE)].map((m) => m[0]);
}

// Logística: Andreani tracking numbers (14-digit numeric) and "SHP-" prefixed IDs.
const TRACKING_NUMBER_RE = /\b\d{14}\b/g;
const SHIPMENT_ID_RE = /\bSHP-[A-Za-z0-9_-]+/gi;
export function extractTrackingMentions(text: string): string[] {
  return [
    ...text.matchAll(TRACKING_NUMBER_RE),
    ...text.matchAll(SHIPMENT_ID_RE),
  ].map((m) => m[0]);
}

// Fiscal: Argentine invoice numbers (XXXX-XXXXXXXX) and CUIT mentions.
const INVOICE_NUMBER_RE = /\b\d{4}-\d{8}\b/g;
const CUIT_RE = /\b\d{2}-?\d{8}-?\d{1}\b/g;
export function extractInvoiceNumberMentions(text: string): string[] {
  return [...text.matchAll(INVOICE_NUMBER_RE)].map((m) => m[0]);
}
export function extractCuitMentions(text: string): string[] {
  return [...text.matchAll(CUIT_RE)].map((m) => m[0]);
}

// Proper-noun name extractor — shared by Ventas + Equipo checks.
// Extracts capitalized 2-3 word sequences as candidate name mentions.
const PROPER_NAME_RE =
  /\b([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+){1,2})\b/g;
export function extractNameMentions(text: string): string[] {
  return [...text.matchAll(PROPER_NAME_RE)].map((m) => m[1]);
}

// ── Per-agent check implementations ─────────────────────────────────────────

export function checkPayments(
  replyText: string,
  catalog: Extract<AgentGuardCatalog, { agent: "payments" }>,
): { reason?: string; detail?: string } {
  if (catalog.paymentIntentId !== null) {
    const mentions = extractPaymentIntentMentions(replyText);
    const strayMention = mentions.find(
      (m) => !mentionMatchesCatalog(m, [catalog.paymentIntentId as string]),
    );
    if (strayMention) {
      return {
        reason: "hallucinated_payment_intent_id",
        detail: `Reply mentions "${strayMention}" but tool returned "${catalog.paymentIntentId}"`,
      };
    }
  }
  if (catalog.customerName) {
    const nameMentions = extractNameMentions(replyText);
    const strayName = nameMentions.find(
      (n) => !mentionMatchesCatalog(n, [catalog.customerName as string]),
    );
    if (strayName) {
      return {
        reason: "hallucinated_customer_name",
        detail: `Reply mentions "${strayName}" but tool received customerName="${catalog.customerName}"`,
      };
    }
  }
  return {};
}

export function checkLogistica(
  replyText: string,
  catalog: Extract<AgentGuardCatalog, { agent: "logistica" }>,
): { reason?: string; detail?: string } {
  const allKnown = [...catalog.trackingNumbers, ...catalog.shipmentIds];
  if (allKnown.length === 0) return {};
  const mentions = extractTrackingMentions(replyText);
  const stray = mentions.find((m) => !mentionMatchesCatalog(m, allKnown));
  if (stray) {
    return {
      reason: "hallucinated_tracking_id",
      detail: `Reply mentions "${stray}" but tool returned IDs: [${allKnown.join(", ")}]`,
    };
  }
  return {};
}

export function checkFiscal(
  replyText: string,
  catalog: Extract<AgentGuardCatalog, { agent: "fiscal" }>,
): { reason?: string; detail?: string } {
  if (catalog.invoiceNumbers.length > 0) {
    const mentions = extractInvoiceNumberMentions(replyText);
    const stray = mentions.find((m) => !mentionMatchesCatalog(m, catalog.invoiceNumbers));
    if (stray) {
      return {
        reason: "hallucinated_invoice_number",
        detail: `Reply mentions invoice "${stray}" but tool emitted: [${catalog.invoiceNumbers.join(", ")}]`,
      };
    }
  }
  if (catalog.customerCuit) {
    const mentions = extractCuitMentions(replyText);
    const stray = mentions.find(
      (m) => !mentionMatchesCatalog(m, [catalog.customerCuit as string]),
    );
    if (stray) {
      return {
        reason: "hallucinated_customer_cuit",
        detail: `Reply mentions CUIT "${stray}" but tool received customerCuit="${catalog.customerCuit}"`,
      };
    }
  }
  return {};
}

export function checkVentas(
  replyText: string,
  catalog: Extract<AgentGuardCatalog, { agent: "ventas" }>,
): { reason?: string; detail?: string } {
  if (catalog.customerNames.length > 0) {
    const mentions = extractNameMentions(replyText);
    const stray = mentions.find((m) => !mentionMatchesCatalog(m, catalog.customerNames));
    if (stray) {
      return {
        reason: "hallucinated_customer_name",
        detail: `Reply mentions "${stray}" but tool calls used customerNames: [${catalog.customerNames.join(", ")}]`,
      };
    }
  }
  // Product name check: only fire when the reply echoes a quoted candidate that
  // doesn't fuzzy-match any known product — conservative to avoid noise on paraphrasing.
  if (catalog.productNames.length > 0) {
    const quotedRe = /["«»""]([^"«»""\n]{2,40})["«»""]/g;
    const quoted = [...replyText.matchAll(quotedRe)].map((m) => m[1]);
    const stray = quoted.find((q) => !mentionMatchesCatalog(q, catalog.productNames));
    if (stray) {
      return {
        reason: "hallucinated_product_name",
        detail: `Reply mentions product "${stray}" but tool calls used productNames: [${catalog.productNames.join(", ")}]`,
      };
    }
  }
  return {};
}

export function checkEquipo(
  replyText: string,
  catalog: Extract<AgentGuardCatalog, { agent: "equipo" }>,
): { reason?: string; detail?: string } {
  if (catalog.employeeNames.length === 0) return {};
  const mentions = extractNameMentions(replyText);
  const stray = mentions.find((m) => !mentionMatchesCatalog(m, catalog.employeeNames));
  if (stray) {
    return {
      reason: "hallucinated_employee_name",
      detail: `Reply mentions "${stray}" but tool calls used employeeNames: [${catalog.employeeNames.join(", ")}]`,
    };
  }
  return {};
}
