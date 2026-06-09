// business_setup Fast Path detector — keeps quick Settings-style commands
// off the Gemini Pro Slow Path (~12-28s cross-region Vertex AI tail latency
// us-central1 ↔ southamerica-east1). Smoke harness turn 8
// ("cambiá el idioma a español") measured 27.1s end-to-end pre-Fast Path,
// breaching the 20s maxDuration of the Next.js route.
//
// Scope intentionally narrow: language and currency are owner-tweakable
// UI settings that don't require LLM reasoning. Other business setup
// fields (businessName, businessType, paymentMethods, openingCash) keep
// going through the Supervisor because they're part of the 6-turn
// onboarding flow and benefit from conversational acknowledgement.
//
// Contract:
//   - Lowercased + accent-stripped before matching (callers may pre-
//     normalize; we re-normalize defensively).
//   - Returns null if the verb/noun pair doesn't bind a known value —
//     dispatcher then falls through to the LLM.
//   - Each successful match carries an enum value the executor can map
//     to a deterministic confirmation without further parsing.

import { normalizeForMatching } from "@/lib/normalize";

export type BusinessSetupFastPathField = "language" | "currency";

export type BusinessSetupLanguageValue = "es-AR" | "en";
export type BusinessSetupCurrencyValue = "ARS" | "USD";

export type BusinessSetupFastPathMatch =
  | { field: "language"; value: BusinessSetupLanguageValue; label: string }
  | { field: "currency"; value: BusinessSetupCurrencyValue; label: string };

// Verbos que introducen un cambio de Settings. `cambia(r)` cubre la variante
// imperativa típica del owner; `pone(r)/pone(le)/setea(r)` cubren las que el
// dictado/STT produce con frecuencia. Sin `^/$` para tolerar interjecciones
// previas ("dale, cambiá el idioma a inglés").
// "quiero cambiar/modificar" and "voy a cambiar" are intentional natural-language
// preambles that previously fell through to the LLM ("quiero cambiar el idioma
// a inglés" was not matched). Added here to keep them on the fast path.
const SETUP_VERB =
  "(?:quiero\\s+(?:cambi[aá]r|modific[aá]r)|voy\\s+a\\s+cambi[aá]r|cambi[aá](?:r|me|le)?|pon[eé](?:r|le|me)?|set[eé]a(?:r|me)?|mod[ií]fic[aá](?:r|me)?)";

// Mapas valor → enum normalizado. Acentos ya stripped por normalizeForMatching.
const LANGUAGE_VALUES: Array<{ pattern: string; value: BusinessSetupLanguageValue; label: string }> = [
  { pattern: "espanol", value: "es-AR", label: "español" },
  { pattern: "castellano", value: "es-AR", label: "español" },
  { pattern: "es-ar", value: "es-AR", label: "español" },
  { pattern: "es", value: "es-AR", label: "español" },
  { pattern: "ingles", value: "en", label: "inglés" },
  { pattern: "en", value: "en", label: "inglés" },
  { pattern: "english", value: "en", label: "inglés" },
];

const CURRENCY_VALUES: Array<{ pattern: string; value: BusinessSetupCurrencyValue; label: string }> = [
  { pattern: "pesos", value: "ARS", label: "pesos argentinos" },
  { pattern: "ars", value: "ARS", label: "pesos argentinos" },
  { pattern: "peso argentino", value: "ARS", label: "pesos argentinos" },
  { pattern: "dolar", value: "USD", label: "dólares" },
  { pattern: "dolares", value: "USD", label: "dólares" },
  { pattern: "usd", value: "USD", label: "dólares" },
];

// "cambiá el idioma a español"
// "poné el idioma en inglés"
const LANGUAGE_RE = new RegExp(
  `${SETUP_VERB}\\s+(?:el\\s+|la\\s+)?(?:idioma|lenguaje|lang|language)\\s+(?:a|en|al|por)\\s+(.+?)\\s*\\.?\\s*$`,
  "i",
);

// "cambiá la moneda a dólares"
// "poné la moneda en pesos"
const CURRENCY_RE = new RegExp(
  `${SETUP_VERB}\\s+(?:la\\s+|el\\s+)?(?:moneda|divisa|currency)\\s+(?:a|en|al|por)\\s+(.+?)\\s*\\.?\\s*$`,
  "i",
);

function resolveValue<T extends { pattern: string }>(
  rawValue: string,
  table: ReadonlyArray<T>,
): T | null {
  const cleaned = rawValue.trim().replace(/[,.;:!?]+$/g, "").trim();
  if (!cleaned) return null;
  // Match exact or as a prefix of the raw tail — "ingles porque ..." should
  // still bind "ingles" rather than fall through to the LLM.
  for (const entry of table) {
    if (cleaned === entry.pattern || cleaned.startsWith(`${entry.pattern} `) || cleaned.startsWith(`${entry.pattern},`)) {
      return entry;
    }
  }
  // Fallback: token-by-token contains, lets "el idioma a espanol por favor"
  // bind without requiring exact end-of-string match.
  for (const entry of table) {
    const re = new RegExp(`\\b${entry.pattern}\\b`);
    if (re.test(cleaned)) return entry;
  }
  return null;
}

export function detectBusinessSetupFastPath(text: string): BusinessSetupFastPathMatch | null {
  if (!text || text.trim().length === 0) return null;
  const normalized = normalizeForMatching(text).replace(/\s+/g, " ").trim();

  const langMatch = normalized.match(LANGUAGE_RE);
  if (langMatch && langMatch[1]) {
    const resolved = resolveValue(langMatch[1], LANGUAGE_VALUES);
    if (resolved) {
      return { field: "language", value: resolved.value, label: resolved.label };
    }
  }

  const currencyMatch = normalized.match(CURRENCY_RE);
  if (currencyMatch && currencyMatch[1]) {
    const resolved = resolveValue(currencyMatch[1], CURRENCY_VALUES);
    if (resolved) {
      return { field: "currency", value: resolved.value, label: resolved.label };
    }
  }

  return null;
}
