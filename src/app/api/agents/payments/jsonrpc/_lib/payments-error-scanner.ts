// Payments Agent prose error scanner — extracted from handle-payments-rpc.ts.
//
// IMPORTANT — the structured tool-result path (V-7 dataPart) is preferred.
// When create_payment_link returns a structured { error } field the ADK tool
// result is forwarded as a dataPart. This scanner is a LEGACY FALLBACK for cases
// where the LLM narrates the error in free text (ADK prompt-injection or unexpected
// Gemini tool-call deviation). Patterns are tight to avoid false positives.

const PAYMENTS_ERROR_PATTERNS: Array<{ pattern: RegExp; code: string }> = [
  // Matches token-expiry messages that explicitly mention expiry or reconnect prompt.
  // expir[oó] covers "expiró"; expir(?:ad[oa]) covers "expirado"/"expirada" (past-participle form).
  { pattern: /Mercado\s+Pago.{0,60}expir(?:[oó]|ad[oa])|token.{0,40}expir(?:[oó]|ad[oa])|reconectalo en Ajustes/i, code: "mp_token_expired" },
  // Matches explicit "connect MP" prompts; "no conectada" alone is too broad.
  // Conect[aá] covers imperative "Conecta" (neutral) and "Conectá" (voseo).
  { pattern: /Conect[aá] tu Mercado Pago|no.{0,30}conectada.{0,30}Mercado Pago|MP no conectado/i, code: "mp_not_connected" },
  // Matches decrypt-failure prose; requires the word "token" near "leer" or "pudo".
  { pattern: /leer el token de Mercado Pago|No se pudo.{0,30}token/i, code: "mp_token_decrypt_error" },
  // Matches missing origin postal code; requires both "código postal" and "negocio"/"origen".
  { pattern: /c[oó]digo postal.{0,40}(negocio|origen)/i, code: "missing_origin_postal_code" },
  // Matches missing destination postal code; requires "destino" or "CP del cliente".
  { pattern: /c[oó]digo postal.{0,40}destino|CP del cliente/i, code: "missing_destination_postal_code" },
  // Matches shipping-quote errors; "cotizar el envío" alone was too broad.
  { pattern: /Error al cotizar|Error cotizando|no pude cotizar/i, code: "shipping_quote_failed" },
  // Matches alias/CBU payment-blocked message; requires both terms near each other.
  { pattern: /alias.{0,30}CBU|generar links de pago por alias/i, code: "payment_links_blocked" },
];

/** Scans prose reply text for known error patterns; returns first match or null. */
export function extractPaymentsErrorCode(text: string): string | null {
  if (!text) return null;
  for (const { pattern, code } of PAYMENTS_ERROR_PATTERNS) {
    if (pattern.test(text)) return code;
  }
  return null;
}
