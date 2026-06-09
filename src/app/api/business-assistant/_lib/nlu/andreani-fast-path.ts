// Andreani Fast Path — deterministic NLU for Andreani shipping commands.
//
// Covers: shipment.quote, shipment.create, shipment.track
//
// Mock mode is always assumed (ANDREANI_MOCK_MODE=true in demo env).
// The executor returns synthetic but realistic responses without calling the Andreani API.
//
// Pattern: detect → return AndreaniIntent | null.
// The dispatcher routes to executeAndreani (in dispatch.ts) which calls
// the Andreani agent stub at /api/agents/andreani/jsonrpc.

import { normalizeForMatching } from "../shared";

// ── Types ─────────────────────────────────────────────────────────────────────

export type AndreaniSkill =
  | "shipment.quote"
  | "shipment.create"
  | "shipment.track";

export interface AndreaniIntent {
  kind: "andreani_fast_path";
  skill: AndreaniSkill;
  // Extracted destination or tracking number, if found
  destinationHint: string | null;
  postalCode: string | null;
  trackingCode: string | null;
  /** Customer name extracted from "mandale el pedido a CUSTOMER" — null when absent. */
  customerName: string | null;
  /**
   * Sale ID threaded from context when the intent follows a confirmed sale.
   * null means no confirmed sale exists yet — executor uses this to detect
   * composite intents (sale + payment + shipment) that must fall through to
   * the Supervisor rather than generating a label directly.
   */
  saleId?: string | null;
}

// ── Patterns ──────────────────────────────────────────────────────────────────

// shipment.quote — "cuánto sale enviar a X" / "cotizá envío al CP 1043"
const QUOTE_VERBS_RE = /\b(cuanto\s+sale|cuanto\s+cuesta|cotiza(?:me|r|me\s+)?|precio\s+(?:del\s+)?(?:envio|flete)|cuanto\s+(?:sale|cuesta)\s+(?:el\s+)?(?:envio|flete))\b/i;
const SHIP_NOUN_RE = /\b(envio|enviar|manda(?:r)?|flete|despacho|despachar)\b/i;

// shipment.create — "generá la etiqueta" / "creá un envío para esta venta"
//   también: "mandale el pedido a juan por andreani" / "mandá el paquete por OCA"
const CREATE_RE = /\b(genera(?:me|r|á)?(?:\s+la)?\s+etiqueta|crea(?:r|me|á)?\s+(?:un\s+)?envio|prepara(?:r|me|á)?\s+(?:el\s+)?(?:envio|paquete)|imprimi(?:r|me|á)?\s+(?:la\s+)?etiqueta|registra(?:r|me|á)?\s+(?:el\s+)?envio|manda(?:le|les|r|me|la|lo)?|mandá)\b/i;

// Customer name extraction for "mandale el pedido a CUSTOMER por X"
// Stops before prepositions (por, de, en, con, hacia, a, para) so "Juan por andreani"
// yields "Juan" not "Juan por".
const MANDA_CUSTOMER_RE = /\b(?:mandale|mandales|mandar|manda|mandá)\b.*?\ba\s+([A-ZÁÉÍÓÚ][a-záéíóúñü]+(?:\s+(?!(?:por|de|en|con|hacia|para|al|el|la|los|las)\b)[A-Za-záéíóúñü]+)?)\b/i;

// shipment.track — deterministic intent + tracking-number extraction.
// Matches before any LLM call per ADK workflow-agent pattern (template agents
// determine execution sequence without consulting an AI model for orchestration):
// https://adk.dev/agents/workflow-agents
//
// Covers:
//   verb-first  : "trackeá NNNNN", "tracking ARK-123", "rastrear el envío"
//   noun-first  : "seguimiento del paquete/pedido/envío"
//   where-query : "¿dónde está mi envío?", "donde esta mi envio", "donde queda el paquete"
//   state-query : "cómo va el envío", "estado del envío"
//
// Guard policy: TRACK_RE has two ambiguous tokens that produce false positives:
//   - "estado del pedido" — also matches purchase/sales-order status queries
//     ("estado del pedido de compra").
//   - bare "rastrear" — also matches non-shipping usage ("rastrear mis gastos").
// After a TRACK_RE hit, a secondary shipping qualifier is required when the text
// does NOT already contain an unambiguous shipping indicator (envio, paquete,
// flete, despacho, tracking keyword, trackea verb, seguimiento, or Andreani
// mention). If the qualifier is absent, the hit is treated as ambiguous and
// falls through to the Supervisor.
// Tracking codes always qualify independently (checked before TRACK_RE).
const TRACK_RE =
  /\b(?:como\s+va\s+(?:el\s+)?envio|estado\s+del\s+envio|tracking|trackea\w*|rastrear?|seguimiento\s+del\s+(?:paquete|pedido|envio)|donde\s+(?:esta|queda)\s+(?:(?:mi|el)\s+)?(?:envio|paquete))\b/i;

// Secondary shipping-qualifier guard for ambiguous TRACK_RE hits.
// A hit is unambiguously a shipping intent when the text contains at least
// one of: explicit ship nouns (envio, paquete, flete, despacho), the
// "seguimiento" token, the "tracking"/"trackea*" keywords, or an Andreani
// mention. This prevents "estado del pedido de compra" and "rastrear mis
// gastos" from routing to shipment.track.
// Note: "paquete" is intentionally included here even though it is not in
// SHIP_NOUN_RE (which covers create/quote verbs) — it IS a shipping noun for
// the purpose of the track qualifier guard.
//
// "trackea\w*" (no trailing \b) is intentional: AR conjugations like
// "trackeame", "trackealo", "trackear" all start with "trackea" but have
// word-chars after it, so a bare \btrackea\b would not match them.
// "rastrear" is deliberately NOT self-qualifying here — it is handled only
// via explicit ship nouns (envio/paquete) to prevent "rastrear mis gastos"
// from routing to shipment.track.
const TRACK_SHIP_QUALIFIER_RE =
  /\b(?:envio|paquete|flete|despacho|despachar|seguimiento|tracking|andreani)\b|\btrackea\w*/i;
const TRACKING_CODE_RE = /\b(ARK-?[A-Z0-9]{4,}|[A-Z]{2}\d{8,}[A-Z]{2}|\d{12,16})\b/i;

// Postal code: 4-digit AR postal code (old) or 8-char alphanumeric (new CSPL)
const POSTAL_CODE_RE = /\b(?:CP\s*)?(\d{4}(?:[A-Z]{3})?|\d{4})\b/i;

// Argentine cities — common destination hints
const DESTINATION_RE = /\b(?:a|hacia|en|para)\s+([A-ZÁÉÍÓÚ][a-záéíóúñü]+(?:\s+[A-Za-záéíóúñü]+){0,3})\b/;

const ANDREANI_MENTION_RE = /\bandreani\b/i;

// Payment-link phrases must NOT be stolen from the Payments agent.
// "link de pago con envío / generar link + envío" routes to Payments → Logística,
// not to this fast path. Detecting on "envío" alone would intercept them.
const PAYMENT_LINK_EXCLUSION_RE = /\blink\s+(?:de\s+)?(?:pago|cobro)\b|\bgenerar?\s+(?:un\s+)?link\b|\blink\s+(?:con|para)\s+(?:envio|flete)\b/i;

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractPostalCode(text: string): string | null {
  const match = POSTAL_CODE_RE.exec(text);
  return match?.[1] ?? null;
}

function extractDestination(text: string): string | null {
  const match = DESTINATION_RE.exec(text);
  return match?.[1]?.trim() ?? null;
}

function extractTrackingCode(text: string): string | null {
  const match = TRACKING_CODE_RE.exec(text);
  return match?.[1] ?? null;
}

function extractCustomerName(text: string): string | null {
  const match = MANDA_CUSTOMER_RE.exec(text);
  return match?.[1]?.trim() ?? null;
}

// ── Detector ──────────────────────────────────────────────────────────────────

/**
 * Detects Andreani fast-path commands from owner text.
 * Returns null if no Andreani command was found.
 */
export function detectAndreaniIntent(text: string): AndreaniIntent | null {
  if (!text || text.trim().length < 5) return null;

  // Do NOT intercept payment-link requests — those belong to the Payments agent.
  // "link de pago con envío" must reach the Supervisor → Payments → Logística path.
  if (PAYMENT_LINK_EXCLUSION_RE.test(text)) return null;

  const normalized = normalizeForMatching(text);
  const mentionsAndreani = ANDREANI_MENTION_RE.test(text);

  // shipment.track — tracking code found OR deterministic track-verb/noun match.
  // Secondary qualifier guard: a TRACK_RE hit is only accepted as an unambiguous
  // shipping intent when the text also contains a shipping qualifier
  // (TRACK_SHIP_QUALIFIER_RE) or mentions Andreani. This prevents false positives
  // on "estado del pedido de compra" and bare "rastrear" (see TRACK_RE comment).
  // Tracking codes bypass the guard and always win.
  const trackingCode = extractTrackingCode(text);
  const hasTrackVerb = TRACK_RE.test(normalized);
  // Test qualifier against normalized (accent-stripped) text so "envío", "trackeá",
  // etc. match the ASCII patterns in TRACK_SHIP_QUALIFIER_RE without requiring
  // diacritic variants in the regex.
  const hasShipQualifier =
    TRACK_SHIP_QUALIFIER_RE.test(normalized) || mentionsAndreani;
  if (trackingCode || (hasTrackVerb && hasShipQualifier)) {
    return {
      kind: "andreani_fast_path",
      skill: "shipment.track",
      destinationHint: null,
      postalCode: null,
      trackingCode: trackingCode,
      customerName: null,
    };
  }

  // shipment.create — generate label / create shipment.
  // "mandale el pedido/envío/paquete a X" also triggers this skill (courier optional).
  //
  // Guard: a ship-noun alone is sufficient to qualify.
  // Product nouns (alfajores, facturas, menú, etc.) do NOT satisfy SHIP_OBJECT_RE,
  // so "mandale tres alfajores a carlos" and "mandale el menú a juan" still fall
  // through to the Supervisor LLM for the full sale→pago→envío chain.
  // Courier mention (andreani/oca/correo) is optional — "mandale el paquete a juan"
  // must match without a courier because the ship-noun alone disambiguates.
  const MANDALE_RE = /\b(mandale|mandales|mandar|manda|mandá)\b/i;
  // Ship nouns only — plain product names must NOT satisfy this.
  // Note: "caja" intentionally excluded — "mandale una caja de [product]" is a common
  // AR quantity expression and would false-positive on product sales. Shipping intent
  // is unambiguously covered by pedido/paquete/envío/orden.
  const SHIP_OBJECT_RE = /\b(pedido|paquete|env[ií]o|orden)\b/i;
  const isMandale = MANDALE_RE.test(text);
  const mandaleQualifies =
    isMandale &&
    SHIP_OBJECT_RE.test(normalized);  // ship noun required — product names do not qualify

  if ((CREATE_RE.test(text) || CREATE_RE.test(normalized)) && !isMandale) {
    // Classic "generá la etiqueta / creá un envío" — no customer context needed.
    return {
      kind: "andreani_fast_path",
      skill: "shipment.create",
      destinationHint: extractDestination(text),
      postalCode: extractPostalCode(text),
      trackingCode: null,
      customerName: null,
    };
  }

  if (mandaleQualifies) {
    // "mandale el pedido a Juan por Andreani" — extract customer + destination.
    const customerName = extractCustomerName(text);
    return {
      kind: "andreani_fast_path",
      skill: "shipment.create",
      destinationHint: extractDestination(text),
      postalCode: extractPostalCode(text),
      trackingCode: null,
      customerName,
    };
  }

  // shipment.quote — quote shipping cost
  const isQuote = QUOTE_VERBS_RE.test(normalized) || QUOTE_VERBS_RE.test(text);
  const hasShipNoun = SHIP_NOUN_RE.test(normalized);
  const hasPostalCode = extractPostalCode(text) !== null;
  const hasDestination = DESTINATION_RE.test(text);

  if (isQuote && (hasShipNoun || hasPostalCode || hasDestination || mentionsAndreani)) {
    return {
      kind: "andreani_fast_path",
      skill: "shipment.quote",
      destinationHint: extractDestination(text),
      postalCode: extractPostalCode(text),
      trackingCode: null,
      customerName: null,
    };
  }

  return null;
}
