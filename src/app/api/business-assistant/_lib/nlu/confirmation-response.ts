// Deterministic detector for sí/no when a confirmationRequest is pending.
//
// Problem: the assistant emits a confirmationRequest card with Confirmar /
// Cancelar buttons; the dueño/empleado often types "sí" / "no" / "ok" /
// "cancelar" instead of tapping. That text round-trips through Gemini Pro
// (owner) or Flash (employee) and adds 4-8s of latency to what is structurally
// a 1-bit answer.
//
// This detector returns "yes" | "no" | null. It is intentionally
// conservative: if the input has any extra content beyond the canonical
// affirmative/negative ("sí, pero cambiá el monto"), it returns null so the
// turn falls through to the LLM, which is the right call when the user is
// modifying the request, not answering it.
//
// Mirrors `src/app/dashboard/lib/hooks/confirmation-intent.ts` (client side)
// so server and client agree on the vocabulary. Stays under 150 LOC.

import { normalizeForMatching } from "../shared";

export type ConfirmationAnswer = "yes" | "no" | null;

// Single-word and short-multi-word phrases that map cleanly to yes/no.
// Multi-word entries are normalized + tokenized so word order doesn't
// matter for "mejor no" / "no gracias" style phrasings.
const YES_TOKENS = new Set([
  "si", "sí", "ok", "okey", "oka", "okay", "dale", "listo",
  "bueno", "bien", "confirmo", "confirma", "confirmar", "confirmado",
  "perfecto", "va", "vamos", "hagamoslo", "hacelo", "sale",
  "claro", "obvio", "obviamente", "yes", "ya",
]);

const NO_TOKENS = new Set([
  "no", "nope", "nah", "cancelar", "cancela", "cancelá", "cancelalo",
  "cancelala", "cancel", "abortar", "aborta", "parar", "para", "pará",
  "frena", "frená", "dejá", "deja", "dejalo", "dejala", "olvidalo",
  "olvidate", "olvídalo", "olvídate", "basta",
]);

// Multi-word phrases — checked as a whole-string match after normalization
// so "mejor no" does not match "mejor", and "no gracias" beats lone "no"
// when both appear. The set is small enough to stay readable.
const YES_PHRASES = new Set<string>([
  "ok dale", "dale ok", "si si", "si dale", "dale si",
  "si confirma", "ok confirma", "si listo", "si sale", "si ok",
]);

const NO_PHRASES = new Set<string>([
  "mejor no", "no gracias", "no quiero", "ni en pedo",
  "no cancela", "no cancel",
]);

const MAX_LENGTH = 30; // longer than this is almost certainly compound

export function detectConfirmationAnswer(text: string): ConfirmationAnswer {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > MAX_LENGTH) return null;

  // Strip trailing punctuation that users often add ("sí!", "ok.", "no..").
  // Normalize accents + casing for matching, but keep the original token
  // sequence so phrase matching is meaningful.
  const stripped = trimmed.replace(/[.!?¿¡,;:]+$/g, "").trim();
  const normalized = normalizeForMatching(stripped).replace(/[.!?¿¡,;:]+/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized) return null;

  // Multi-word phrase match first — covers "mejor no" / "no gracias".
  if (NO_PHRASES.has(normalized)) return "no";
  if (YES_PHRASES.has(normalized)) return "yes";

  const tokens = normalized.split(/\s+/);

  // Single-token: direct lookup.
  if (tokens.length === 1) {
    const t = tokens[0];
    if (YES_TOKENS.has(t)) return "yes";
    if (NO_TOKENS.has(t)) return "no";
    return null;
  }

  // Two- or three-token: only accept if EVERY token is a yes/no marker
  // from the same family. This catches "ok dale", "si si si" without
  // letting "dale cargá 5" or "sí pero cambialo" through.
  if (tokens.length <= 3) {
    const allYes = tokens.every((t) => YES_TOKENS.has(t));
    const allNo = tokens.every((t) => NO_TOKENS.has(t));
    if (allYes && !allNo) return "yes";
    if (allNo && !allYes) return "no";
  }

  return null;
}
