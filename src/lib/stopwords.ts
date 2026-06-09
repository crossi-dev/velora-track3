// SINGLE SOURCE OF TRUTH for Spanish stopwords used across the chat pipeline.
//
// Audit ref: velora/audit/parsing-tanda-1/text-normalization H-1
// Three independent stopword sets existed with overlapping but non-identical
// coverage. When a new filler word appeared in production only one set was
// updated and the others silently misfired.
//
// Strategy:
//   - Grammatical base: stopword.spa corpus (MIT, v3) pre-normalized
//     (accent-stripped via NFKC→NFD→\p{M} removal, matching normalizeForMatching).
//   - AR-specific grammatical extensions (vos paradigm, rioplatense fillers).
//   - Domain verb set: Velora-specific voseo imperatives and sale verbs.
//   - Domain query set: interrogative / catalog-query words.
//   - Helper filterStopwords() to apply multiple sets in one pass.
//
// Adding a new word: choose the right set below, add it once, done.
// Do NOT add stopword constants to individual files — import from here.

// ── GRAMMATICAL_STOPWORDS_ES ─────────────────────────────────────────────────
//
// General-purpose Spanish grammatical stopwords: articles, prepositions,
// conjunctions, pronouns. Covers es-ES and es-AR (rioplatense) forms.
//
// Base corpus: stopword@3 `spa` list (59 entries), pre-normalized to strip
// accents (más→mas, él→el, también→tambien, etc.) so lookups work after
// normalizeForMatching() runs on user text. Duplicates deduplicated.
// Corpus entries: a, al, como, con, contra, cual, cuando, de, del, desde,
//   donde, durante, el, ella, en, ese, eso, hasta, la, las, le, lo, los,
//   mas, me, mi, muy, ni, no, nos, o, otro, para, pero, poco, por, porque,
//   que, quien, se, si, sin, sobre, su, sus, tambien, te, ti, tu, un, una,
//   uno, y, ya

export const GRAMMATICAL_STOPWORDS_ES: ReadonlySet<string> = new Set([
  // stopword.spa corpus (accent-normalized)
  "a", "al", "como", "con", "contra", "cual", "cuando",
  "de", "del", "desde", "donde", "durante",
  "el", "ella", "en", "ese", "eso",
  "hasta", "la", "las", "le", "lo", "los",
  "mas", "me", "mi", "muy",
  "ni", "no", "nos",
  "o", "otro",
  "para", "pero", "poco", "por", "porque",
  "que", "quien",
  "se", "si", "sin", "sobre", "su", "sus",
  "tambien", "te", "ti", "tu",
  "un", "una", "uno",
  "y", "ya",
  // AR vos paradigm (not in es-ES corpora)
  "vos", "vosotros", "vuestro", "vuestra", "vuestros", "vuestras",
  // Extra grammatical words not in the spa corpus
  "unas", "unos",
  "lo", "les",
  "este", "esta", "esto", "esa", "estos", "estas", "esas", "esos",
  "todo", "toda", "todos", "todas",
  "otra", "otros", "otras",
  "cuales",
  "u",       // conjunction variant of "o"
  // Rioplatense discourse markers / fillers
  "asi", "aca", "alla", "ahi",
  "che", "dale", "ok", "oka", "okey",
  "bueno", "bien", "buen", "buenas",
  "porfa", "porfi", "porfis", "porfavor",
  "gracias", "hola",
  "ahora", "rapido", "urgente", "igual",
]);

// ── DOMAIN_VERBS_ES ──────────────────────────────────────────────────────────
//
// Velora-domain voseo imperatives and sale/send verbs.
// These appear in user chat but carry no catalog information — strip them
// before product/customer matching.

export const DOMAIN_VERBS_ES: ReadonlySet<string> = new Set([
  // Sale verbs — conjugation forms used in rioplatense chat
  "vendi", "vende", "vendo", "vendile", "vendele", "vender", "vendiendo",
  "vendete", "vendia", "venta", "ventas", "ventita",
  // Collection / invoice verbs
  "cobrale", "cobrar", "cobra", "cobro", "cobrales", "cobrame",
  "factura", "facturar", "facturale", "facturado",
  // Send / WhatsApp verbs
  "mandale", "mandar", "manda", "mande", "mando", "mandales",
  "envia", "enviar", "enviale", "envio",
  "wapp", "whatsapp", "wsp", "wpp", "wa", "watsap", "guasap",
  // Voseo imperatives used to address the system
  "decime", "dame", "mostrame", "pasame", "tirame", "chequeame",
  "buscame", "mandame", "avisame", "cargame", "registrame",
  // Show / display
  "mostra", "mostrar",
  // Existence / availability
  "hay", "tiene", "tengo", "queda", "quedan",
]);

// ── DOMAIN_QUERY_WORDS_ES ────────────────────────────────────────────────────
//
// Interrogative and catalog-query words: words users type when asking about
// products, prices, or stock that are not product names themselves.

export const DOMAIN_QUERY_WORDS_ES: ReadonlySet<string> = new Set([
  "cuanto", "cuanta", "cuantos", "cuantas",
  "precio", "vale", "cuesta", "stock", "inventario", "cantidad",
]);

// ── filterStopwords ──────────────────────────────────────────────────────────
//
// Returns tokens that are NOT present in any of the provided sets.
// Accepts multiple sets so callers can compose exactly the sets they need.
//
// Example:
//   filterStopwords(tokens, [GRAMMATICAL_STOPWORDS_ES, DOMAIN_VERBS_ES])

export function filterStopwords(
  tokens: string[],
  sets: ReadonlySet<string>[],
): string[] {
  if (sets.length === 0) return tokens;
  return tokens.filter((token) => sets.every((set) => !set.has(token)));
}
