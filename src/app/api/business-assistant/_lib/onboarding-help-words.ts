// Shared "owner is confused / asking for help" detector.
//
// Every free-text onboarding parser (T3b alias, T7 product input, etc.) must
// run input through isHelpOrConfusion BEFORE attempting to extract data.
// Without this guard the parsers happily save "ayudame", "no se", "?" or
// "me perdi" as business data and skip ahead (audit 2026-05-24 — T3b
// captured "ayudame" as a valid alias).
//
// Categories covered:
//   1. Explicit help requests        — "ayuda", "ayudame", "socorro", "help"
//   2. Confusion / lost              — "no se", "no entiendo", "me perdi"
//   3. Questions / curiosity         — "que", "como", "por que", "qué hago"
//   4. Lone punctuation              — "?", "¿?", "..."
//   5. Cancel / back / restart       — "cancelar", "volver", "atras", "parar"
//   6. Apologies / hesitation        — "perdón", "perdona", "mmm", "eh"
//   7. Generic chip-style yes/no     — "si", "no", "ok", "dale" (lone, no data)
//
// Detection is diacritic-insensitive (NFD strip) and case-insensitive.
// Punctuation is tolerated at start/end to catch "ayudame!", "?ayuda?", etc.

import { normalizeForMatching } from "@/lib/normalize";

// Single-token vocab (post-normalization). Matched after stripping trailing
// punctuation. Cheap O(1) lookup.
const HELP_VOCAB: Set<string> = new Set([
  // Help
  "ayuda", "ayudame", "ayudenme", "ayudame por favor", "socorro", "auxilio",
  "help", "please", "por favor",
  // Confusion / lost
  "no se", "no entiendo", "no entendi", "me perdi", "estoy perdido",
  "estoy perdida", "perdi", "no comprendo", "no comprendi", "no la entiendo",
  "no se que hacer", "no se que poner", "no se que decir", "no tengo idea",
  "ni idea", "no la pesco",
  // Questions / curiosity (lone — without an actual data answer)
  "que", "que?", "como", "como?", "cual", "cuando", "donde", "por que",
  "para que", "que es", "que es esto", "que hace", "que hago", "que pongo",
  "que escribo", "que digo", "que tengo que poner", "como hago", "como hacemos",
  "como funciona", "que onda", "que onda esto",
  // Cancel / back / restart
  "cancelar", "cancela", "cancelado", "volver", "atras", "atrasito",
  "salir", "salgo", "deshacer", "parar", "alto", "esperate", "esperá",
  "espera", "esperame", "stop", "basta", "no quiero", "no por ahora",
  "despues", "mas tarde", "otro dia", "empezar de nuevo", "reiniciar",
  "otra vez", "de nuevo", "borralo", "borra todo",
  // Apologies / hesitation — clearly NOT data, the owner is stalling
  "perdon", "perdona", "perdoname", "disculpa", "disculpame", "lo siento",
  "mmm", "ehh", "uhh", "ehmm", "ehmmm",
  // NOTE: pure acks ("si", "no", "ok", "dale", "listo", "bueno") are
  // intentionally NOT in this list. They are valid chip values in several
  // turns (T5d "listo" = finish products, T6 connect-mp "dale" = yes, etc.)
  // and intercepting them as help would block real flows. If the per-turn
  // parser does not match an ack, the fast path falls to the LLM as before.
]);

// Lone-punctuation / non-alphanumeric inputs. "ayuda?" or "?" or "..." should
// all read as confusion. We strip trailing punctuation before the vocab check
// and we also catch the pure-punctuation case explicitly.
const PUNCT_ONLY_RE = /^[?¿!¡.,;:\s-]+$/;

// Trailing punctuation we strip before vocab lookup. Keeps internal dots so
// real aliases ("carlos.mp") that get fed in by mistake do NOT get classified
// as help.
const TRAILING_PUNCT_RE = /[?¿!¡.,;:\s]+$/;

export function isHelpOrConfusion(text: string): boolean {
  if (typeof text !== "string") return false;
  const trimmed = text.trim();
  if (trimmed.length === 0) return false; // empty handled by the caller separately
  if (PUNCT_ONLY_RE.test(trimmed)) return true;
  const normalized = normalizeForMatching(trimmed).replace(TRAILING_PUNCT_RE, "");
  if (normalized.length === 0) return true;
  if (HELP_VOCAB.has(normalized)) return true;
  // Substring guard for help-leading phrases (e.g. "ayuda por favor con esto")
  // that the vocab can't enumerate exhaustively. Only fires when the input is
  // short — long inputs are presumed to be real data.
  if (normalized.length <= 30) {
    if (/^(ayuda|ayudame|ayudenme|socorro|help|me perdi|no se|no entiendo|no entendi|que hago|que pongo|que escribo|cancel|volver|atras|parar|esperate|borr)\b/.test(normalized)) {
      return true;
    }
  }
  return false;
}
