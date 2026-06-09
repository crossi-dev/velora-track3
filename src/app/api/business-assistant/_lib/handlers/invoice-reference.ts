// Shared invoice-reference detection helper.
//
// Extracted from invoices.ts to stay under the 300-line file-size contract
// and to allow detect-wrappers.ts (C1 fix) to import hasInvoiceReference
// without pulling in the full invoice handler graph.
//
// Fix M4 — JD adversarial review Step 1, 2026-05-28.

// Payroll context guard — "recibo" is both noun (invoice/receipt) and
// 1st-person present of "recibir". The noun "recibo de sueldo" is payroll,
// not an invoice artifact. Block invoice-path routing when payroll keywords
// are present alongside "recibo".
const PAYROLL_BLOCKLIST_RE = /\b(sueldo|haberes|salario)\b/i;

/**
 * Returns true when the normalized text references an invoice/receipt artifact.
 *
 * Accepts a pre-normalized string (lowercased, accent-stripped) produced by
 * normalizeForMatching(). Callers must normalize before passing.
 *
 * Exported so that:
 *   - invoices.ts (looksLikeInvoiceLookupRequest) can use it internally.
 *   - detect-wrappers.ts (C1 fix) can bail out of detectSaleSendFastPath
 *     early when the text references an invoice artifact, preventing
 *     "mandale el comprobante a Juan" from routing to label 4 (sale_send).
 */
export function hasInvoiceReference(normalized: string): boolean {
  if (normalized.includes("factura") || normalized.includes("comprobante")) {
    return true;
  }
  if (normalized.includes("recibo") && !PAYROLL_BLOCKLIST_RE.test(normalized)) {
    return true;
  }
  return false;
}
