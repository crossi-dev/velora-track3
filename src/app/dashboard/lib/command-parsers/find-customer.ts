import { tLang } from "../DashboardLangContext";
import type { ContactRow } from "../types";
import type { VeloraSingleCommand } from "./shared";

// Matches Spanish phrasings that ask for a customer's info by name or
// phone. Captures the search term (usually a name fragment, sometimes
// a phone number).
//
// Ordering note: these patterns are tried in order; the first that
// captures a non-empty query wins. Request-prefixed forms come first
// so "dame los datos de X" / "buscá a X" are stripped down to the
// name before the bare-verb patterns try to match.
const REQUEST_PREFIX_RE =
  /^(?:decime|deci|dame|mostrame|mostra|fijate|fijame|chequea|a\s+ver|busca(?:me|le)?|buscar|encontra(?:r|me)?|encuentra(?:me)?)\s+(?:el\s+|la\s+|los\s+|las\s+|un\s+|una\s+)?/;

const FIND_CUSTOMER_PATTERNS: RegExp[] = [
  // "cliente X" or "al cliente X" (stripped of request prefix)
  /^(?:al\s+|a\s+)?cliente\s+(.+?)\??$/,
  // "datos/información/info/contacto (de) X"
  /^(?:datos|informacion|info|contacto)\s+(?:de\s+)?(.+?)\??$/,
  // "teléfono/tel/número (de) X"
  /^(?:telefono|tel|numero|celular|celu)\s+(?:de\s+)?(.+?)\??$/,
  // "email/correo/mail (de) X"
  /^(?:email|correo|mail|e-mail)\s+(?:de\s+)?(.+?)\??$/,
  // "quién es X"
  /^quien\s+es\s+(.+?)\??$/,
];

export function detectFindCustomer(
  normalized: string
): VeloraSingleCommand | null {
  // First try with the request prefix stripped (covers "dame los datos
  // de juan" → "los datos de juan" — but the patterns above handle the
  // article-less form). We try the stripped form AND the original so
  // either ordering matches.
  const stripped = normalized.replace(REQUEST_PREFIX_RE, "").trim();
  const candidates = stripped && stripped !== normalized ? [stripped, normalized] : [normalized];

  for (const text of candidates) {
    for (const pattern of FIND_CUSTOMER_PATTERNS) {
      const m = text.match(pattern);
      if (!m) continue;
      const query = cleanQuery(m[1]);
      if (!query || query.length < 2) continue;
      return {
        matched: true,
        intent: "find_customer",
        data: { query },
      };
    }
  }
  return null;
}

// Trim stopwords that sometimes come back inside the captured query
// ("del cliente juan" → "del cliente juan" after prefix strip → we
// want "juan"). Keep this light — aggressive stripping would eat
// legitimate name tokens.
function cleanQuery(raw: string): string {
  return raw
    .trim()
    .replace(/^(?:el\s+|la\s+|los\s+|las\s+|al\s+|a\s+|un\s+|una\s+|del\s+|de\s+|mi\s+)+/, "")
    .trim();
}

// ── Catalog search (pure, exported for testing) ────────────────────
//
// Rank clients by match quality against the query:
//   1. Exact name match (accent-insensitive, case-insensitive)
//   2. Name starts-with
//   3. Name contains
//   4. Phone contains (digits-only comparison)
// Returns the best single match or null if nothing scored.

function normalizeForLookup(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function digitsOnly(value: string | null | undefined): string {
  return (value ?? "").replace(/\D+/g, "");
}

export function findCustomerInCatalog(
  clients: ContactRow[],
  query: string
): ContactRow | null {
  const q = normalizeForLookup(query);
  const qDigits = digitsOnly(query);
  if (!q && !qDigits) return null;

  let best: { score: number; match: ContactRow } | null = null;
  for (const client of clients) {
    const name = normalizeForLookup(client.name);
    const phoneDigits = digitsOnly(client.phone);
    let score = 0;
    if (q && name === q) score = Math.max(score, 100);
    else if (q && name.startsWith(q)) score = Math.max(score, 80);
    else if (q && name.includes(q)) score = Math.max(score, 60);
    if (qDigits && qDigits.length >= 4 && phoneDigits.includes(qDigits)) {
      score = Math.max(score, 70);
    }
    if (score > 0 && (!best || score > best.score)) {
      best = { score, match: client };
    }
  }
  return best?.match ?? null;
}

// ── Reply builders (pure, exported for testing) ────────────────────

export function buildFindCustomerReply(match: ContactRow): string {
  const parts: string[] = [tLang(`Customer: ${match.name}`, `Cliente: ${match.name}`)];
  if (match.phone) parts.push(`Tel: ${match.phone}`);
  if (match.email) parts.push(`Email: ${match.email}`);
  return parts.join(" — ") + ".";
}

export function buildFindCustomerNotFoundReply(): string {
  return tLang("No customer found with that name.", "No encontré ningún cliente con ese nombre.");
}
