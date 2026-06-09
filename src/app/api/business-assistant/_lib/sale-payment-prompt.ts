// Pre-LLM intercept: when the user states a sale intent without specifying
// a payment method ("vendí 2 alfajores"), we short-circuit BEFORE hitting
// the LLM and return payment-method chips so the user can tap a single
// option. The tapped chip re-submits the original text with the method
// appended (e.g. "vendí 2 alfajores en efectivo") and the normal sale flow
// runs as if the user had typed it complete from the start.
//
// Design decisions:
// - False negatives (sale without method not detected) are ACCEPTABLE —
//   the LLM handles the message normally, which may ask for the method.
// - False positives (non-sale detected as sale) would be annoying, so the
//   regex requires: (1) a sale verb AND (2) a quantity number in the text.
// - Already-methodized inputs (/efectivo|qr|mercado.?pago|.../) are NOT
//   intercepted — they fall through to the deterministic dispatcher.
// - sale_send inputs ("vendí X y mandale wpp") are NOT intercepted — they
//   carry a WhatsApp-send keyword meaning the user wants autoSend, not a
//   payment-method prompt. These go to the deterministic sale_send path.

import { containsSendKeyword } from "@/lib/sale-send-detection";
import type { ChipsBundle } from "@/app/api/supervisor/_lib/supervisor-chips";

export interface SaleWithoutMethodMatch {
  matched: true;
  originalInput: string;
}

// Chip value max length — must leave room for the longest appended suffix
// (" con cobro por QR" = 18 chars) within the 80-char chipsSchema limit.
// 62 + 18 = 80. Applies to all method chip values in buildSalePaymentPromptResult.
const MAX_CHIP_INPUT_LEN = 62;

/**
 * Returns a match when `text` looks like a sale intent that is missing a
 * payment method. Returns null otherwise (caller should continue normally).
 *
 * Requirements:
 *   - Contains a sale verb (vend*, cobrame, cobrale, hago/hice venta, vendele)
 *   - Contains at least one digit (quantity guard — prevents bare "vendí"
 *     or "vendí algo" from triggering, which the sale handler already asks
 *     for product/quantity clarification on its own)
 *   - Does NOT already contain a payment method keyword
 *   - Does NOT contain a WhatsApp send keyword — those are sale_send intents
 *     (handled by the deterministic dispatcher, label 4) and should NOT be
 *     intercepted here. Bug #39: "vendí 2 alfajores a carlos y mandale wpp"
 *     was asking for payment method instead of auto-sending.
 */
export function detectSaleWithoutPaymentMethod(
  text: string,
): SaleWithoutMethodMatch | null {
  // \b word boundaries fail on accented chars (vendí, factúrale) in JS regex
  // because \w only matches ASCII [a-zA-Z0-9_]. Split into two checks:
  //   1. Verb presence — use (?:^|\s)…(?:\s|$) to anchor without \b
  //   2. Digit presence — separate test so the verb regex stays readable
  const normalized = text.toLowerCase();
  const hasSaleVerb =
    /(?:^|\s)(vend[ií]|cobrame|cobrale|vendele|factur[aá]l[eé])(?:\s|$)/.test(
      normalized,
    ) || /(hago|hice)\s+\S*venta/.test(normalized);
  if (!hasSaleVerb) return null;
  if (!/\d/.test(text)) return null;

  // sale_send guard: if the text already carries a WhatsApp send keyword
  // ("mandale", "wpp", "whatsapp", etc.), the user wants autoSend — not a
  // payment-method picker. Fall through to the deterministic dispatcher
  // so sale_send (label 4) can handle it correctly with autoSend: true.
  if (containsSendKeyword(normalized)) return null;

  const hasMethod =
    /\b(efectivo|qr|mercado.?pago|tarjeta|transferencia|cash|cheque)\b/i.test(
      text,
    );
  if (hasMethod) return null;

  return { matched: true, originalInput: text.trim() };
}

export interface SalePaymentPromptResult {
  answer: string;
  chips: ChipsBundle;
  actions: unknown[];
}

/**
 * Builds the short-circuit response body for a sale intent without method.
 * When `businessAcceptsMP` is false, the QR chip is omitted.
 * When `transferAlias` is a non-empty string, a "Transferencia" chip is added.
 *
 * Chip values are capped at 80 chars (chipsSchema limit). originalInput is
 * truncated to MAX_CHIP_INPUT_LEN before appending the method suffix so the
 * combined string never exceeds the limit. Bug #47: long inputs caused
 * ZOD_BODY_VALIDATION_FAILED when the client echoed chips back to chat-history.
 */
export function buildSalePaymentPromptResult(
  originalInput: string,
  businessAcceptsMP: boolean,
  transferAlias: string | null = null,
): SalePaymentPromptResult {
  // Truncate to MAX_CHIP_INPUT_LEN so all derived chip values stay ≤ 80 chars.
  const safeInput = originalInput.slice(0, MAX_CHIP_INPUT_LEN);
  const options: ChipsBundle["options"] = [
    { label: "💵 Efectivo", value: `${safeInput} en efectivo` },
  ];

  if (businessAcceptsMP) {
    options.push({
      label: "📱 Cobrar por QR",
      value: `${safeInput} con cobro por QR`,
    });
  }

  if (transferAlias) {
    options.push({
      label: "🏦 Transferencia (alias)",
      value: `${safeInput} por transferencia`,
    });
  }

  options.push({
    label: "✖ Cancelar",
    value: "cancelar venta",
  });

  return {
    answer: "¿Cómo cobrás? Tocá una opción.",
    chips: { kind: "single", options },
    actions: [],
  };
}
