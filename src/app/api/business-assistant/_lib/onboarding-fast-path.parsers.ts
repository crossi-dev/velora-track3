// Parsers determinísticos de los 5 turnos del onboarding. Cada parser recibe
// el texto crudo del dueño y devuelve el valor canónico (o null si está fuera
// del vocabulario conocido). Los parsers son puros — no leen contexto, no
// escriben DB, solo clasifican.
//
// Provider/contact parsers (detectTransferAlias, detectPostalCode,
// detectCourierChoice, detectWhatsappPhone, detectT6Choice, CourierChoice,
// T6Choice) live in onboarding-fast-path.parsers.providers.ts — re-exported
// below for back-compat with existing importers.

import { normalizeForMatching } from "@/lib/normalize";
import { parseSpanishNumber } from "@/lib/word-to-number";

export {
  detectTransferAlias,
  detectPostalCode,
  detectCourierChoice,
  detectWhatsappPhone,
  detectT6Choice,
} from "./onboarding-fast-path.parsers.providers";
export type { CourierChoice, T6Choice } from "./onboarding-fast-path.parsers.providers";
export { detectT5Choice } from "./onboarding-fast-path.parsers.t5";
export type { T5Choice } from "./onboarding-fast-path.parsers.t5";
export { detectTCustomersChoice } from "./onboarding-fast-path.parsers.t-customers";
export type { TCustomersChoice } from "./onboarding-fast-path.parsers.t-customers";
export { detectConnectChoice } from "./onboarding-fast-path.parsers.t-connect";
export type { ConnectChoice } from "./onboarding-fast-path.parsers.t-connect";

// ── T1: nombre del negocio (free text con guardrails) ──────────────────────
const T1_REJECT_PATTERNS: RegExp[] = [
  // Covers both `?` (U+003F) and `¿` (U+00BF). normalizeForMatching preserves
  // both — only diacritics are stripped, not punctuation. A bare `¿` at the
  // start of a question (no closing `?`) would NOT be caught by `/\?/` alone.
  /[?¿]/, // preguntas — rejects any question-form input
  /^(no se|no entiendo|ayuda|help|que|como|por que|porque)\b/, // duda
  /^(borr|elimina|cancel|desha|ayud)/, // verbos no-onboarding
  // Saludos y acks que NO son nombre de negocio. Sin este guard, el welcome
  // chip ("Sí, arrancamos" / "Contame más") o un "hola" suelto era capturado
  // como businessName y se creaba un Business con ese texto (audit 2026-05-24
  // encontró 5 Business rows fantasma: "hola", "Sí, arrancamos" x3, "Contame más").
  // [.,!]* + \s* tolera puntuación y espacios en chip values ("Sí, arrancamos", "Hola!", etc.)
  /^(hola|holaa+|buenas|buen dia|buenos dias|buenas tardes|buenas noches|hey|ey|hi)[.,!\s]*$/,
  /^(si|sí)[,.\s]*\s*(arrancamos|dale|vamos)?[.,!\s]*$/,
  /^(ok|dale|empecemos|vamos|listo|si listo|si dale)[.,!\s]*$/,
  /^(contame|cuentame|explicame|que es velora|mas info|mas informacion|info|que hace)[.,!\s]*(mas|más|sobre velora)?[.,!\s]*$/,
];

export function looksLikeBusinessNameInput(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > 80) return null; // Business.name no es un párrafo
  const normalized = normalizeForMatching(trimmed);
  if (T1_REJECT_PATTERNS.some((re) => re.test(normalized))) return null;
  // Mínimo razonable: al menos 2 caracteres alfanuméricos.
  if (!/[a-z0-9]{2,}/i.test(normalized)) return null;
  return trimmed.slice(0, 120); // cap defensivo a nivel de columna
}

// Detects the welcome chip "Contame más" and natural-language variants so
// the T1 case can branch into a dedicated explainer instead of the bare
// "¿Cómo se llama tu negocio?" prompt.
const CONTAME_MAS_PATTERN = /^(contame|cuentame|explicame|que es velora|mas info|mas informacion|info|que hace)[.,!\s]*(mas|más|sobre velora)?[.,!\s]*$/;

export function looksLikeContameMasChip(text: string): boolean {
  if (typeof text !== "string") return false;
  const normalized = normalizeForMatching(text.trim());
  return CONTAME_MAS_PATTERN.test(normalized);
}

// Detects the welcome chip "Sí, arrancamos" and its tolerated variants.
// Free-text confusion ("no entiendo") does NOT match — those go to LLM.
const SI_ARRANCAMOS_PATTERN = /^(si|sí)[,.\s]*\s*(arrancamos|dale|vamos)?[.,!\s]*$/;

export function looksLikeSiArrancamosChip(text: string): boolean {
  if (typeof text !== "string") return false;
  const normalized = normalizeForMatching(text.trim());
  return SI_ARRANCAMOS_PATTERN.test(normalized);
}

// Semantic inverse of looksLikeBusinessNameInput — true when text is a chip
// tap, greeting, or affirmation that must NOT be saved as businessName.
export function isLikelyChipResponseNotName(text: string): boolean {
  if (typeof text !== "string") return true;
  return looksLikeBusinessNameInput(text) === null;
}

// ── T2: rubro / tipo de negocio ────────────────────────────────────────────
// B2B aliases added in Fase B. Legacy B2C aliases KEPT so existing businesses
// and free-text still resolve; they are just no longer featured as chips.
const BUSINESS_TYPE_ALIASES: Record<string, string> = {
  // ── B2B (Fase B — canonical chips) ──────────────────────────────────────
  "distribuidora": "Distribuidora",
  "distribuidor": "Distribuidora",
  "distribución": "Distribuidora",
  "distribucion": "Distribuidora",
  "mayorista": "Mayorista",
  "mayoreo": "Mayorista",
  "proveedor": "Proveedor",
  "proveedora": "Proveedor",
  "fabrica": "Fabricante",
  "fábrica": "Fabricante",
  "fabricante": "Fabricante",
  "manufactura": "Fabricante",
  // ── B2C legacy (kept for regression — not featured as chips) ────────────
  "ropa": "Ropa/boutique",
  "boutique": "Ropa/boutique",
  "ropaboutique": "Ropa/boutique",
  "ropa/boutique": "Ropa/boutique",
  "indumentaria": "Ropa/boutique",
  "minimarket": "Mini-market",
  "mini-market": "Mini-market",
  "mini market": "Mini-market",
  "almacen": "Mini-market",
  "kiosco": "Mini-market",
  "kiosko": "Mini-market",
  "despensa": "Mini-market",
  "mascotas": "Mascotas",
  "petshop": "Mascotas",
  "pet shop": "Mascotas",
  "veterinaria": "Mascotas",
  "vete": "Mascotas",
  "belleza": "Belleza",
  "peluqueria": "Belleza",
  "estetica": "Belleza",
  "cosmetica": "Belleza",
  "otro": "Otro",
  "otros": "Otro",
};

export function detectBusinessType(text: string): string | null {
  const normalized = normalizeForMatching(text).trim();
  if (!normalized) return null;
  // Preferimos las entradas más largas para que "mini market" gane sobre "mini".
  const keys = Object.keys(BUSINESS_TYPE_ALIASES).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (normalized === key) return BUSINESS_TYPE_ALIASES[key];
    const re = new RegExp(`^${key.replace(/[/-]/g, "[/\\- ]")}$`);
    if (re.test(normalized)) return BUSINESS_TYPE_ALIASES[key];
  }
  return null;
}

// Verbos explícitos de cambio de tipo.
// Cubre: "cambiá el tipo a X", "quise decir X", "no, es X", "en realidad es X".
// NOTE: `\bera\b` and `\bes\b` require word boundaries to avoid false-positives
// where common Spanish words like "quilmes" contain "es" as a substring.
// Without \b, any text containing a business-type keyword AND ANY word ending
// in "es"/"era" (e.g. "cajas de quilmes") incorrectly triggers a type change.
const TYPE_CHANGE_VERB_RE =
  /(?:cambi[aá](?:r|me|le)?|modific[aá](?:r|me)?|actualiz[aá](?:r|me)?|quise decir|no[,\s]+es|no[,\s]+somos|en realidad(?:\s+es|\s+somos)?|\bera\b|\bes\b)/;

/**
 * Detecta un intento de CAMBIO de tipo de negocio cuando T2 ya estaba resuelto.
 * Devuelve el tipo canónico si:
 *   (a) el input contiene un verbo/frase de cambio explícito + un tipo conocido, o
 *   (b) el input es exactamente el nombre de un tipo conocido (chip re-tapado).
 * Devuelve null si no se puede determinar el tipo con certeza.
 */
export function detectBusinessTypeChange(text: string): string | null {
  const normalized = normalizeForMatching(text).trim();
  if (!normalized) return null;

  // Caso (b): chip exacto o sinónimo puro sin verbo (dueño volvió a tapear el chip).
  const direct = detectBusinessType(text);
  if (direct) return direct;

  // Caso (a): contiene verbo de cambio + tipo conocido en cualquier posición.
  if (!TYPE_CHANGE_VERB_RE.test(normalized)) return null;
  const keys = Object.keys(BUSINESS_TYPE_ALIASES).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    const re = new RegExp(`\\b${key.replace(/[/-]/g, "[/\\- ]")}\\b`);
    if (re.test(normalized)) return BUSINESS_TYPE_ALIASES[key];
  }
  return null;
}

// ── T3: métodos de pago (multi-match) ──────────────────────────────────────
const PAYMENT_METHOD_KEYWORDS: Array<{ canonical: string; patterns: RegExp[] }> = [
  { canonical: "Efectivo", patterns: [/\befectivo\b/, /\bcash\b/, /\bplata\b/] },
  { canonical: "Mercado Pago", patterns: [/\bmercado ?pago\b/, /\bmp\b/, /\bqr\b/] },
  { canonical: "Tarjeta", patterns: [/\btarjeta\b/, /\bdebito\b/, /\bcredito\b/, /\bposnet\b/] },
  { canonical: "Transferencia", patterns: [/\btransferencia\b/, /\btransfer\b/, /\bcbu\b/, /\balias\b/] },
];

export function detectPaymentMethods(text: string): string[] | null {
  const normalized = normalizeForMatching(text);
  const matched: string[] = [];
  const seen = new Set<string>();
  for (const entry of PAYMENT_METHOD_KEYWORDS) {
    if (entry.patterns.some((re) => re.test(normalized))) {
      if (seen.has(entry.canonical)) continue;
      seen.add(entry.canonical);
      matched.push(entry.canonical);
    }
  }
  return matched.length > 0 ? matched : null;
}

// ── T4: caja inicial (número literal o palabras) ───────────────────────────
// Delegates to parseSpanishNumber() from @/lib/word-to-number for word-based
// amounts. Audit ref: velora/audit/parsing-tanda-1/number-date-parsing.

export function parseAmount(text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  // 1. Numérico literal: "20000", "$20.000", "20,000", "20k".
  //    k-suffix handled by parseSpanishNumber — delegate after stripping $ only.
  const noSign = trimmed.replace(/^\$\s*/, "");
  const cleaned = noSign.replace(/\./g, "").replace(",", ".");
  if (/^\d/.test(cleaned)) {
    const parsed = Number(cleaned);
    if (Number.isFinite(parsed) && parsed >= 0 && parsed < 1e12) return parsed;
  }

  // 2. Word-based amounts: delegate to canonical parseSpanishNumber().
  //    Covers "veinte mil", "ciento cincuenta", "20k", "cero", etc.
  const normalized = normalizeForMatching(trimmed);
  const wordResult = parseSpanishNumber(normalized);
  if (wordResult !== null && wordResult >= 0) return wordResult;

  return null;
}

// T5 (cómo cargar el primer producto) parser lives in
// onboarding-fast-path.parsers.t5.ts — re-exported above for back-compat.

// ── T5b: cantidad inicial del primer producto ──────────────────────────────
// Se dispara cuando ya hay 1 producto creado con stock=0 y la pregunta del
// supervisor fue "¿cuántas unidades tenés?". El dueño responde un número o
// "no sé" / "ninguno". Sin esto el "20" cae al supervisor LLM y se interpreta
// como stock_query (consulta) en vez de adjust_stock set.
const T5B_ZERO_PATTERNS: RegExp[] = [
  /^no se$/, /^no se sabe$/, /^no se cuantas?$/, /^no se cuantos?$/,
  /^ninguno$/, /^ninguna$/, /^no tengo$/, /^no recuerdo$/, /^no contad?as?$/,
  /^todavia no$/, /^todavia ninguno$/, /^aun no$/, /^aun ninguno$/,
];

export function parseStockQuantityResponse(text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const normalized = normalizeForMatching(trimmed);
  if (!normalized) return null;

  // 1. "no sé" / "ninguno" / "no tengo" → 0
  if (T5B_ZERO_PATTERNS.some((re) => re.test(normalized))) return 0;

  // 2. Número literal aislado: "20", "100", "1500" (hasta 6 dígitos)
  if (/^\d{1,6}$/.test(normalized)) {
    const n = Number(normalized);
    if (Number.isFinite(n) && n >= 0 && n < 1_000_000) return n;
  }

  // 3. Palabras numéricas. Guardrails antes de parsear:
  //   - Si mezcla letras y dígitos ("alfajor 500", "te paso 10") es nombre+precio,
  //     no cantidad pura. Cae al supervisor.
  //   - Si tiene `$`, `.` o `,` parece formato monetario ("$20.000"). Cae al
  //     supervisor para que aclare.
  if (/[$.,]/.test(trimmed)) return null;
  if (/\d/.test(normalized) && /[a-z]/.test(normalized)) return null;

  // 3a+3b. Word-based via parseSpanishNumber() (canonical, covers single tokens
  //        AND compound forms like "veinte mil", "ciento cincuenta").
  //        parseAmount() also delegates there, but calling directly is cleaner
  //        for the pure-word branch here.
  const wordAmount = parseSpanishNumber(normalized);
  if (wordAmount !== null && wordAmount >= 0 && wordAmount < 1_000_000) {
    return wordAmount;
  }

  return null;
}
