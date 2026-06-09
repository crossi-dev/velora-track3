import { tLang } from "../DashboardLangContext";
import type { InvoiceStatusKey, UpdateInvoiceStatusData, VeloraSingleCommand } from "./shared";

export type { InvoiceStatusKey, UpdateInvoiceStatusData };

// Status keyword groups. "paid" (pagada/cobrada) is the most common
// transition, followed by "sent" (enviada) and occasionally "issued"
// (emitida, usually the initial state).
// Includes past-tense verb forms (accent-stripped) so "ya cobré" →
// "cobre" → paid matches. "pago" / "cobro" can be nouns but appear in
// the status slot of the pattern, which is positionally isolated.
const PAID_TOKENS = /\b(?:pagada|pagado|cobrada|cobrado|paga|cobre|cobro|pague|pago)\b/;
const SENT_TOKENS = /\b(?:enviada|enviado|mandada|mandado|envie|envio|mande|mando)\b/;
const ISSUED_TOKENS = /\b(?:emitida|emitido|emiti|emito|abierta|abierto)\b/;

// Patterns:
// - "marcá la factura 0034 como pagada"
// - "la factura 2024-001 está pagada" / "la factura 0034 ya cobré"
// - "factura 0034 pagada"
// Captures the invoice number as a loose token (digits optionally with
// hyphen, letters rare but accepted). Dispatcher matches it against
// ctx.invoices[].invoiceNumber via case-insensitive substring.
// Changed from {3,} to {1,}: 1-2 digit Argentine invoice numbers must match.
const INVOICE_NUMBER_GROUP = "([A-Za-z0-9-]{1,})";

const STATUS_PATTERNS: RegExp[] = [
  // "marcá/marcar la factura X como STATUS"
  new RegExp(`^(?:marca(?:le|me)?|marca|marcar|actualiza(?:le|me)?|actualiza)\\s+(?:la\\s+|el\\s+)?factura\\s+${INVOICE_NUMBER_GROUP}\\s+(?:como\\s+|a\\s+)(.+?)\\??$`),
  // "la factura X está/ya cobré/pagué STATUS" OR just "factura X STATUS"
  new RegExp(`^(?:la\\s+|el\\s+)?factura\\s+${INVOICE_NUMBER_GROUP}\\s+(?:ya\\s+|esta\\s+|está\\s+)?(.+?)\\??$`),
];

function mapStatusWord(text: string): InvoiceStatusKey | null {
  if (PAID_TOKENS.test(text)) return "paid";
  if (SENT_TOKENS.test(text)) return "sent";
  if (ISSUED_TOKENS.test(text)) return "issued";
  return null;
}

export function detectUpdateInvoiceStatus(normalized: string): VeloraSingleCommand | null {
  for (const pattern of STATUS_PATTERNS) {
    const m = normalized.match(pattern);
    if (!m) continue;
    const invoiceNumberQuery = m[1].trim();
    const statusText = m[2].trim();
    if (invoiceNumberQuery.length < 1) continue;
    const status = mapStatusWord(statusText);
    if (!status) continue;
    return {
      matched: true,
      intent: "update_invoice_status",
      data: { invoiceNumberQuery, status },
    };
  }
  return null;
}

// Resolve the parser's invoice query against the live invoice list.
// Three tiers, most specific first. Returns the unique match or null
// (caller falls through to AI on null).
//
// The previous implementation used a plain substring match which
// produced false positives for partial-subsequence queries:
//   query "0034" against invoice "REC-0001-00000340" → matched the
//   wrong invoice because "0034" is a substring of "00000340".
//
// Tiers:
//   1. Exact full-string match (case-insensitive).
//   2. All-digit query → match against the invoice's trailing numeric
//      run with leading-zero normalization. So "34", "0034", and
//      "00000034" all match "REC-0001-00000034" and crucially do NOT
//      match "REC-0001-00000340" (whose trailing run is "340").
//   3. Suffix match — invoice ends with the query string. Handles
//      partial structured queries like "0001-00000034".
//
// On ambiguity (>1 match within a tier) we return null so the user is
// asked to be more specific via AI fallback.
export function resolveInvoiceByQuery(
  query: string,
  invoices: Array<{ id: string; invoiceNumber: string; status: InvoiceStatusKey }>,
): { id: string; invoiceNumber: string; status: InvoiceStatusKey } | null {
  const q = query.toLowerCase().trim();
  if (!q) return null;

  // Tier 1: exact match.
  const exact = invoices.filter((inv) => inv.invoiceNumber.toLowerCase() === q);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;

  // Tier 2: trailing-digit-run match with leading-zero normalization.
  // Gated on all-digit query so text queries don't trigger false confidence.
  if (/^\d+$/.test(q)) {
    const qStripped = q.replace(/^0+/, "") || "0";
    const tailMatches = invoices.filter((inv) => {
      const tailRun = inv.invoiceNumber.match(/(\d+)$/);
      if (!tailRun) return false;
      const tail = tailRun[1].replace(/^0+/, "") || "0";
      return tail === qStripped;
    });
    if (tailMatches.length === 1) return tailMatches[0];
    if (tailMatches.length > 1) return null;
  }

  // Tier 3: suffix match for partial structured queries.
  const suffix = invoices.filter((inv) => inv.invoiceNumber.toLowerCase().endsWith(q));
  if (suffix.length === 1) return suffix[0];

  return null;
}

export function buildUpdateInvoiceStatusConfirmMessage(
  invoiceNumber: string,
  status: InvoiceStatusKey,
): string {
  const statusLabel: Record<InvoiceStatusKey, string> = {
    issued: tLang("issued", "emitida"),
    sent: tLang("sent", "enviada"),
    paid: tLang("paid", "pagada"),
  };
  return tLang(`Mark invoice ${invoiceNumber} as ${statusLabel[status]}?`, `¿Marcar la factura ${invoiceNumber} como ${statusLabel[status]}?`);
}
