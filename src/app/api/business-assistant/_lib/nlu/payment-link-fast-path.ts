// Payment Link Fast Path — deterministic NLU for payment-link requests.
//
// Detects owner commands like:
//   "generá un link de pago para María García por 3 filtros de aire con envío"
//   "mandá un link de cobro a Juan por 2 camisetas"
//   "link de pago para Carlos"
//   "armá un link de cobro para el pedido de Laura"
//
// These requests MUST reach the Payments Agent via call_ventas_agent. The
// Supervisor LLM is explicitly bypassed: when the LLM receives this kind of
// message it has the catalog in context, computes the total itself, and then
// asks a clarifying question about shipping — it NEVER invokes call_ventas_agent.
//
// Root cause (confirmed 2026-05-18): the PRIORITY_TABLE had no entry for
// payment-link intents, so detectDeterministicIntent returned null for this
// text, and the owner pipeline fell through to ownerSupervisorStage. The
// Supervisor LLM answered directly instead of delegating.
//
// Fix: add a deterministic detector that fires before the LLM slow path.
// The executor reuses call-ventas-agent-tool's resolveVentasShipping /
// injectResolvedAmount pre-resolution logic and dispatches directly to the
// Payments Agent — exactly as call_ventas_agent.execute() would, but without
// waiting for the LLM to decide to call it.

import { normalizeForMatching } from "../shared";
import type { PaymentLinkSendIntent, PaymentLinkCancelIntent } from "./types";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PaymentLinkFastPathIntent {
  kind: "payment_link_fast_path";
  /** Raw original text — forwarded to the Payments Agent pre-resolver. */
  rawText: string;
}

// ── Patterns ──────────────────────────────────────────────────────────────────

// Primary signal: "link de pago" / "link de cobro".
// Also covers "link para cobrar", "link de pago/cobro", "un link de".
const LINK_PAGO_RE = /\blink\s+de\s+(pago|cobro)\b/i;

// Secondary: "armá/generá/creá/mandá un link" (with or without "de pago/cobro").
// The verb must precede "link" to avoid false positives on "link de producto".
const LINK_VERB_RE = /\b(arm[aá]|gener[aá]|cre[aá]|crea(?:me)?|mand[aá]|hac[eé](?:me)?|prepar[aá])\s+(?:un\s+|el\s+)?link\b/i;

// Negative: "cómo" / "cuándo" / "por qué" before "link" → it's a question,
// not a creation request. These go to the LLM as business_query.
const QUESTION_PREFIX_RE = /\b(como|como se|cuando|por que|que es|para que)\b.*\blink\b/i;

// Note (2026-05-27): SALE_VERB_WITH_LINK_RE guard was removed.
// "vendele 3 cajas de alfajor a Juan con envío, mandale link de pago"
// must route to payment_link_fast_path, NOT sale_send.
// Reason: payment_link_fast_path → executePaymentLinkFastPath → Payments Agent
// → create_payment_link → registerSaleWithPaymentLinkUseCase creates Sale +
// Invoice + PaymentIntent atomically AND quotes Andreani for "con envío".
// sale_send only returns a client-side register_sale modal action — it never
// generates a payment link or quotes shipping.

// "QR de cobro" / "cobrar con QR/mp" — owner wants in-store or WhatsApp QR payment.
// Audit ref: Gap 3 — NLU comprehension audit 2026-05-28 (agent ab2c390e63637a524).
// These phrases don't contain "link" so they bypass the quick-reject below, but they
// clearly express a payment-collection intent that belongs to the Payments Agent.
// Guard: requires an explicit payment-provider or QR signal alongside a cobro verb
// to avoid matching "cobrar en efectivo" or other non-digital payment phrasing.
const QR_COBRO_RE = /\bQR\s+de\s+cobro\b/i;
const COBRAR_QR_RE = /\bcobrar?\s+(?:con\s+)?(?:QR|mp|mercado\s*pago)\b/i;

// H1 fix — JD adversarial review Step 1, 2026-05-28.
// "cobrar mp es facil?" / "como cobro con QR?" are info questions, not commands.
// Guard fires when the text contains an info-question token AND lacks a clear
// directive verb ("cobrale", "generale", "armale"). In that case, return null
// and let the LLM answer the informational question.
const QR_QUESTION_RE = /\b(como(?:\s+se)?|cuando|por\s+qu[eé]|qu[eé]\s+es|para\s+qu[eé]|es\s+f[aá]cil|conviene)\b/i;
// Directive verbs that override the question guard even if QR_QUESTION_RE fires.
// e.g. "cobrale con mp, es fácil" has a directive and should still route fast-path.
// H1-regression fix (JD Round 2, 2026-05-28): removed `?` from clitic suffix
// so `cobra` (3rd person, e.g. "como se cobra con mp?") no longer qualifies as
// a directive. Only forms with a mandatory clitic (`cobrale`, `cobrate`,
// `cobrame`) override the question guard.
const QR_DIRECTIVE_RE = /\b(cobr[aá](?:le|te|me)|gener[aá]|arm[aá]|mand[aá]|cre[aá])\b/i;

// "cobrale + wpp/whatsapp" pattern — owner wants to charge a customer via
// WhatsApp without using the word "link". Routes to payment_link_fast_path
// (same Payments Agent endpoint) instead of registering a direct sale.
// Guard: must contain an explicit WhatsApp send signal ("wpp", "whatsapp",
// "por wpp", "mandale wpp"). Bare "cobrale" WITHOUT a wpp signal continues
// to fall through to sale_send (counter/POS intent).
// cobrale / cobrate / cobrame — all map to the same "charge them" intent.
const COBRALE_RE = /\bcobr[aá](?:le|te|me)?\b/i;
const WPP_SIGNAL_RE = /\b(wpp|whatsapp|por\s+wpp|por\s+whatsapp|mandale\s+wpp|mandá(?:le)?\s+wpp)\b/i;

// ── Detector ──────────────────────────────────────────────────────────────────

/**
 * Returns a PaymentLinkFastPathIntent when the text is a payment-link creation
 * request, null otherwise.
 *
 * Owner-only: the dispatcher guards actorRole; this detector doesn't need to
 * re-check it. The PRIORITY_TABLE entry carries a guard (actorRole === "owner").
 *
 * Also handles "cobrale X a Y por wpp" — routes to payment_link instead of
 * sale_send when the owner explicitly includes a WhatsApp send signal.
 */
export function detectPaymentLinkFastPath(
  text: string,
): PaymentLinkFastPathIntent | null {
  if (!text || text.trim().length < 5) return null;

  const normalized = normalizeForMatching(text);

  // "QR de cobro" / "cobrar con QR/mp" — payment-collection via QR without "link".
  // Must fire BEFORE the "link" quick-reject below.
  // H1 fix: apply question guard — "cobrar mp es facil?" is informational, not a command.
  // COBRAR_QR_RE has /i so testing against normalized is sufficient; redundant text-test removed (M2).
  if (QR_COBRO_RE.test(text) || COBRAR_QR_RE.test(normalized)) {
    const isQuestion = QR_QUESTION_RE.test(normalized) && !QR_DIRECTIVE_RE.test(normalized);
    if (isQuestion) return null;
    return { kind: "payment_link_fast_path", rawText: text };
  }

  // "cobrale … por wpp/whatsapp" — payment link via WhatsApp without "link".
  // Must fire BEFORE the "link" quick-reject below.
  if (COBRALE_RE.test(text) && WPP_SIGNAL_RE.test(normalized)) {
    return { kind: "payment_link_fast_path", rawText: text };
  }

  // Must mention "link" at all — quick rejection for remaining patterns.
  if (!normalized.includes("link")) return null;

  // Reject question phrasing ("cómo genero un link de pago").
  if (QUESTION_PREFIX_RE.test(normalized) || QUESTION_PREFIX_RE.test(text)) return null;

  // Primary: "link de pago/cobro" → strongest signal, matches unconditionally.
  if (LINK_PAGO_RE.test(text) || LINK_PAGO_RE.test(normalized)) {
    return { kind: "payment_link_fast_path", rawText: text };
  }

  // Secondary: action verb + "link" (e.g. "generá un link para María").
  if (LINK_VERB_RE.test(text) || LINK_VERB_RE.test(normalized)) {
    return { kind: "payment_link_fast_path", rawText: text };
  }

  return null;
}

// ── Chip-tap detectors ────────────────────────────────────────────────────────
//
// These detectors match the machine-token values that are submitted when the
// owner taps a chip from the payment-link review card. They are exact-match /
// prefix-match against the token format and are NEVER typed by a human.

/**
 * Detects "enviar_link_pago|{phone}|{paymentIntentId}" chip-tap messages.
 * Returns a PaymentLinkSendIntent with parsed phone + paymentIntentId, or null.
 *
 * The chip value stores a paymentIntentId (cuid, ~25 chars) instead of the
 * full checkout URL to stay within the 80-char Zod limit on chip values.
 * The executor resolves the URL from the PaymentIntent DB row.
 */
export function detectPaymentLinkSend(
  text: string,
): PaymentLinkSendIntent | null {
  if (!text.startsWith("enviar_link_pago|")) return null;
  const parts = text.split("|");
  // Exactly 3 parts: ["enviar_link_pago", phone, paymentIntentId]
  if (parts.length !== 3) return null;
  const phone = parts[1]?.trim();
  const paymentIntentId = parts[2]?.trim();
  if (!phone || !paymentIntentId) return null;
  return { kind: "payment_link_send", phone, paymentIntentId };
}

/**
 * Detects "cancelar_link_pago" exact chip-tap message.
 * Returns a PaymentLinkCancelIntent or null.
 */
export function detectPaymentLinkCancel(
  text: string,
): PaymentLinkCancelIntent | null {
  if (text.trim() === "cancelar_link_pago") return { kind: "payment_link_cancel" };
  return null;
}
