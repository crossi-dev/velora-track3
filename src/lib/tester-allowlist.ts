// Single source of truth for emails that bypass all rate limits in production.
// Hardcoded by design — do NOT move to env vars (rate-limit bypass is a security
// surface and must be auditable via git blame). Add a new entry by PR.
export const TESTER_EMAILS: ReadonlySet<string> = new Set([
  "owner@example.com",
  "tester@example.com",
  "contact@example.com",
]);

export function isTesterEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return TESTER_EMAILS.has(email.toLowerCase().trim());
}
