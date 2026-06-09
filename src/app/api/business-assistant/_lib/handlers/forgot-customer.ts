import { normalizeForMatching } from "../shared";

// Phrases (pre-normalized — no accents) that indicate the user doesn't
// remember the customer name. Match is substring `.includes` so short
// variants will cover longer ones.
const FORGOT_PATTERNS = [
  // Explicit memory failures
  "no recuerdo",
  "no me acuerdo",
  "no me acordaba",
  "no me acordas",
  "no recordaba",
  "no recuerdo a",
  "no me acuerdo a",
  "olvide",
  "me olvide",
  "se me olvido",
  "se me fue el nombre",
  "se me fue",
  "no me sale el nombre",
  "no me sale",
  "no me viene el nombre",
  "no me viene",
  // Explicit ignorance
  "no se el cliente",
  "no se quien",
  "no se a quien",
  "no se el nombre",
  "no se bien",
  "no se como",
  "no tengo idea",
  "ni idea",
  "sin idea",
  // Generic placeholders
  "sin cliente",
  "cliente desconocido",
  "algun cliente",
  "alguien",
  "una persona",
  "un cliente",
];

// Gating keywords so we only route to picker when the user is describing
// a sale-like transaction. `vend`, `cobr`, `factur` catch Spanish verb
// stems regardless of conjugation.
const SALE_KEYWORDS = ["vend", "venta", "cobr", "factur", "le pase", "le deje anotado"];

// Argentine slang pattern: "cobré por una/un/dos/tres [product]" — the user
// registered a sale using "cobré por [product]" without specifying a customer.
// "por" + article/number after "cobr" indicates a product was named, not a
// customer. This pattern fires forgot_customer so the customer picker appears
// instead of a generic unresolved-intent fallback.
const COBRO_POR_PRODUCT_RE = /\bcobr[eé]\s+por\s+(un[ao]|dos|tres|cuatro|cinco|\d+)\b/;

export function looksLikeSaleWithForgottenCustomer(text: string): boolean {
  if (!text) return false;
  const normalized = normalizeForMatching(text);

  // Fast path for "cobré por una/un [producto]" Argentine slang — no explicit
  // forgot phrase needed; the grammar itself implies no customer was stated.
  if (COBRO_POR_PRODUCT_RE.test(normalized)) return true;

  const hasForgot = FORGOT_PATTERNS.some((p) => normalized.includes(p));
  if (!hasForgot) return false;

  const hasSaleContext = SALE_KEYWORDS.some((k) => normalized.includes(k));
  if (!hasSaleContext) return false;

  // Guard: don't trigger when the user explicitly names a customer
  // ("vendí a Juan pero no recuerdo cuánto"). "a <Capital>" with a name
  // suggests the customer is known, even if something else is forgotten.
  const mentionsNamedCustomer =
    /\b(a|para)\s+[A-Z][a-záéíóúñ]{2,}/.test(text) &&
    !/\b(a|para)\s+(un|una|alguien|algun|alguna|varios|varias)\b/i.test(text);
  if (mentionsNamedCustomer) return false;

  return true;
}
