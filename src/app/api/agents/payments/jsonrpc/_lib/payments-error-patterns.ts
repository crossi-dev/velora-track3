// Prose-to-error-code scanner for the Payments Agent RPC handler.
//
// IMPORTANT — structured path is preferred over this scanner.
// When create_payment_link returns a structured `{ error }` field, the ADK
// tool result is forwarded as a `dataPart` — that is the reliable,
// Gemini-rephrasing-proof path. This prose scanner is a LEGACY FALLBACK for
// cases where the LLM narrates the error in free text rather than returning it
// in the structured tool result (e.g. ADK prompt-injection or unexpected
// Gemini tool-call deviation). Patterns must therefore be tight enough to
// avoid false positives on non-error prose.

// Known machine-readable error codes emitted by the Payments Agent tools.
// Maps keyword patterns found in the LLM's prose reply to a stable code.
const PAYMENTS_ERROR_PATTERNS: Array<{ pattern: RegExp; code: string }> = [
  // Matches token-expiry messages that explicitly mention expiry or the
  // reconnect prompt — avoids matching generic "Mercado Pago" sentences.
  { pattern: /\bMercado\s+Pago\b.{0,60}\bexpiró\b|\btoken\b.{0,40}\bexpirado\b|\breconectalo en Ajustes\b/i, code: "mp_token_expired" },
  // Matches explicit "connect MP" prompts; "no conectada" alone is too broad.
  { pattern: /\bConectá tu Mercado Pago\b|\bno\b.{0,30}\bconectada\b.{0,30}\bMercado Pago\b|\bMP no conectado\b/i, code: "mp_not_connected" },
  // Matches decrypt-failure prose; requires the word "token" near "leer" or "pudo".
  { pattern: /\bleer el token de Mercado Pago\b|\bNo se pudo\b.{0,30}\btoken\b/i, code: "mp_token_decrypt_error" },
  // Matches missing origin postal code; requires both "código postal" and "negocio"/"origen".
  { pattern: /\bcódigo postal\b.{0,40}\b(negocio|origen)\b/i, code: "missing_origin_postal_code" },
  // Matches missing destination postal code; requires "destino" or "CP del cliente".
  { pattern: /\bcódigo postal\b.{0,40}\bdestino\b|\bCP del cliente\b/i, code: "missing_destination_postal_code" },
  // Matches shipping-quote errors; "cotizar el envío" alone was too broad and matched
  // non-error LLM prose (e.g. confirmation sentences). Only genuine error phrasings match.
  { pattern: /\bError al cotizar\b|\bError cotizando\b|\bno pude cotizar\b/i, code: "shipping_quote_failed" },
  // Matches alias/CBU payment-blocked message; requires both terms near each other.
  { pattern: /\balias\b.{0,30}\bCBU\b|\bgenerar links de pago por alias\b/i, code: "payment_links_blocked" },
];

/** Scans prose reply text for known error patterns; returns first match or null. */
export function extractPaymentsErrorCode(text: string): string | null {
  if (!text) return null;
  for (const { pattern, code } of PAYMENTS_ERROR_PATTERNS) {
    if (pattern.test(text)) return code;
  }
  return null;
}
