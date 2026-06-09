// External Agent Fast Path — deterministic NLU for peer A2A commands.
//
// Detects owner commands directed at trusted external agents:
//   "pedile precio a Distribuidora Mendoza de 50 cajas de Quilmes"
//   "cotizame 100 unidades de harina en Distribuidora Mendoza"
//   "comprá 50 cajas de Quilmes a Distribuidora Mendoza"
//
// Returns a structured ExternalAgentIntent or null if the text doesn't match.
// The Supervisor dispatches this via callExternalAgent().

import { normalizeForMatching } from "../shared";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ExternalAgentIntent {
  kind: "external_agent_call";
  // Peer name fragment extracted from text. Caller resolves to domain.
  peerHint: string;
  // Detected skill
  skillId: "wholesale.price.quote" | "wholesale.order.create";
  // Raw product + qty string for the handler to parse
  productText: string;
  qty: number | null;
}

// ── Patterns ──────────────────────────────────────────────────────────────────

// Verbs that indicate a PRICE QUOTE request
const QUOTE_RE = /\b(cotiza(?:me|la|lo)?|pedile precio|pedi(?:le)? (?:precio|cotizacion)|precio (?:de|del)|cuanto sale|consulta(?:le)? precio)\b/i;

// Verbs that indicate a PURCHASE ORDER request
const ORDER_RE = /\b(compr[aá](?:me|le)?|pedir?(?:le)?|hac[eé] un pedido|hacer un pedido|crea(?:r|me)? (?:una )?orden|orden de compra)\b/i;

// Peer name indicators — words AFTER "a", "en", "con", "de parte de".
// Run against normalized text (already lowercase) so STT/copy-paste in
// lowercase ("distribuidora mendoza") matches without an uppercase-first-letter
// constraint. The original uppercase-first rule missed lowercase peer names.
const PEER_MARKER_RE = /\b(?:a|en|con|para|de)\s+([a-záéíóúñü]{2,}(?:\s+[a-záéíóúñü]+){0,3})\b/;

// Quantity extraction: "50 cajas", "100 unidades", "30 kg"
const QTY_RE = /\b(\d+(?:[.,]\d+)?)\s*(?:cajas?|unidades?|kg|kilos?|paquetes?|bolsas?|litros?|unid\.?)?/i;

// ── Normalizer ────────────────────────────────────────────────────────────────

function extractPeerHint(text: string): string | null {
  // Run against normalized text (lowercase, no accents) so STT/copy-paste
  // in lowercase still matches. PEER_MARKER_RE no longer requires uppercase
  // first letter, so "distribuidora mendoza" is captured correctly.
  const normalized = normalizeForMatching(text);
  const match = PEER_MARKER_RE.exec(normalized);
  if (match?.[1]) return match[1].trim();
  return null;
}

function extractQty(text: string): number | null {
  const match = QTY_RE.exec(text);
  if (match?.[1]) {
    const n = parseFloat(match[1].replace(",", "."));
    return isNaN(n) ? null : Math.round(n);
  }
  return null;
}

function extractProductText(text: string, qty: number | null): string {
  // Remove the matched qty + peer hint, what remains is likely product text
  let cleaned = text
    .replace(QUOTE_RE, "")
    .replace(ORDER_RE, "")
    .replace(PEER_MARKER_RE, "")
    .replace(/\b\d+(?:[.,]\d+)?\s*(?:cajas?|unidades?|kg|kilos?|paquetes?|bolsas?|litros?|unid\.?)?\b/i, "")
    .replace(/\bde\b|\ben\b|\ba\b|\bcon\b|\bpara\b/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  // If qty was found, also strip it from the front
  if (qty !== null) {
    cleaned = cleaned.replace(new RegExp(`^${qty}\\s*`), "").trim();
  }

  return cleaned || text.trim();
}

// ── Detector ──────────────────────────────────────────────────────────────────

// Mutation verbs that indicate a local price/stock edit — these must NOT be
// misrouted to an external agent. "cambia el precio de X" targets a local
// product; "de X" is the product name, not a peer hint.
const LOCAL_MUTATION_VERB_RE =
  /\b(?:cambia|cambi[ao]|actualiza|actualiz[ao]|ponele?|pon(?:e(?:le?)?)?|baj[ao](?:le)?|sub[io](?:le)?)\b/;

/**
 * Detect external agent commands from owner text.
 * Returns null if the text doesn't match any external-agent pattern.
 */
export function detectExternalAgentIntent(text: string): ExternalAgentIntent | null {
  if (!text || text.trim().length < 5) return null;

  const normalized = normalizeForMatching(text);

  // Bail out for local mutation commands — these target internal products,
  // not external peer agents. Without this guard, "cambia el precio de X"
  // matches PEER_MARKER_RE on "de X" and QUOTE_RE on "precio de".
  if (LOCAL_MUTATION_VERB_RE.test(normalized)) return null;

  // Must have a peer hint to be a directed external agent call
  const peerHint = extractPeerHint(text);
  if (!peerHint) return null;

  // Must match either quote or order pattern
  const isQuote = QUOTE_RE.test(normalized) || QUOTE_RE.test(text);
  const isOrder = ORDER_RE.test(normalized) || ORDER_RE.test(text);

  if (!isQuote && !isOrder) return null;

  const qty = extractQty(text);
  const productText = extractProductText(text, qty);

  return {
    kind: "external_agent_call",
    peerHint,
    skillId: isOrder ? "wholesale.order.create" : "wholesale.price.quote",
    productText,
    qty,
  };
}
