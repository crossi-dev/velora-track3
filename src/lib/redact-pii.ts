/**
 * Lightweight PII redaction for Cloud Logging.
 *
 * Redacts before any user-supplied text reaches a log sink:
 *  - Sequences of 7+ consecutive digits  → [NUM]   (phone, CUIT, credit-card fragments)
 *  - Email-like patterns                  → [EMAIL]
 *
 * Non-PII fields (businessId, actorUserId, employeeId, audit IDs) must NOT
 * be passed through this helper — they are needed for log correlation.
 */
export function redactInput(text: string, maxLen = 80): string {
  // Redact BEFORE truncating so a PII token straddling the boundary does not
  // leave a partial fragment in the output (e.g. a phone number split at
  // the 80-char boundary would survive if we truncated first).
  const redacted = text
    .replace(/\b\d{2}-?\d{8}-?\d{1}\b/g, "[CUIT]")
    .replace(/\b\d{7,}\b/g, "[NUM]")
    .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, "[EMAIL]");
  return redacted.slice(0, maxLen);
}
