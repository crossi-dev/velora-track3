// Chat-history PII redaction (applied on POST write path only).
//
// Before persisting chat `text` to the database, Argentine phone numbers,
// generic phone numbers, CUIT identifiers, and email addresses are
// replaced with placeholders. Reads (GET) are not mutated — historical
// data remains as-is. Placeholders keep the model's downstream context
// coherent without leaking raw values.
//
// IMPORTANT: GENERIC_PHONE_RE and CUIT_RE both use a negative lookbehind
// for the document prefixes REC-/FC-/PRES- (receipts, invoices, budgets).
// Without this guard an invoice number like "0001-00000090" gets
// mistaken for a phone number and redacted to "[tel]", which breaks the
// chat-history dedup check (durable entry text no longer matches the
// local unredacted text, so the success message appears twice on
// refresh).

const AR_PHONE_RE = /\+?54\s?9?\s?\d{1,4}\s?\d{3,4}\s?\d{3,5}/g;
const GENERIC_PHONE_RE = /(?<!(?:REC|FC|PRES)-)(?<!\|)\b\d{2,4}[\s-]?\d{3,4}[\s-]?\d{4}\b/g;
// Negative lookbehind for pipe (|) prevents phone numbers embedded in pipe-delimited
// action-chip tokens (e.g. "enviar_link_pago|1100000000|cmpet…") from being redacted.
const CUIT_RE = /(?<!(?:REC|FC|PRES)-)(?<!\|)\b\d{2}-?\d{7,8}-?\d\b/g;
const EMAIL_RE = /\b[\w.-]+@[\w.-]+\.\w{2,}\b/g;

export function redactPii(input: string): string {
  return input
    .replace(EMAIL_RE, "[email]")
    .replace(AR_PHONE_RE, "[tel]")
    .replace(CUIT_RE, "[cuit]")
    .replace(GENERIC_PHONE_RE, "[tel]");
}
