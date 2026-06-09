// credential-validators.ts — shape validation for communication channel credentials.
//
// Each provider requires specific fields. Validation is structural only —
// we check presence and type, not that the credentials work against the real API.
// API-level failures surface on first use.
//
// Providers:
//   twilio_sms — SMS via Twilio REST API.
//   resend     — Transactional email via Resend.
//   pedidosya  — Delivery integration via PedidosYa API.

export const VALID_PROVIDERS = ["twilio_sms", "resend", "pedidosya"] as const;
export type ChannelProvider = (typeof VALID_PROVIDERS)[number];

type ValidationResult = { ok: true } | { ok: false; error: string };

// Required string fields per provider.
const REQUIRED_FIELDS: Record<ChannelProvider, string[]> = {
  twilio_sms: ["accountSid", "authToken", "from"],
  resend:     ["apiKey"],
  pedidosya:  ["apiToken"],
};

/**
 * Validates the credential object for the given provider.
 * Checks that all required fields are present and are non-empty strings.
 * Optional fields (e.g. resend.from) are not validated here.
 */
export function validateCredentialShape(
  provider: ChannelProvider,
  creds: Record<string, unknown>,
): ValidationResult {
  const required = REQUIRED_FIELDS[provider];
  const missing: string[] = [];

  for (const field of required) {
    const val = creds[field];
    if (typeof val !== "string" || val.trim() === "") {
      missing.push(field);
    }
  }

  if (missing.length > 0) {
    return {
      ok: false,
      error: `Faltan los siguientes campos para ${provider}: ${missing.join(", ")}.`,
    };
  }

  return { ok: true };
}
