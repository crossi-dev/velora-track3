// Parsers for provider/contact onboarding fields (A1 expansion):
// transferAlias, postalCode, courierPreference, whatsappPhone, and MP T6 choice.
// Split from onboarding-fast-path.parsers.ts to keep that file under 300 LOC.
// All parsers are pure — no context reads, no DB writes.

import { normalizeForMatching } from "@/lib/normalize";

// ── T3b: alias o CBU de transferencia ─────────────────────────────────────
// Two valid shapes:
//   CBU:   exactly 22 digits (pure numeric string of length 22)
//   Alias: 3-20 chars, /^[a-zA-Z0-9._-]{3,20}$/, MUST contain a dot — Mercado
//          Pago + bank CVU aliases all follow the "word.word.word" format
//          since 2020. Requiring the dot eliminates ~all false positives
//          where the owner types a help word ("ayudame") or a chat ack
//          ("dale") that happens to fit the character class.
// Anything else → null and the caller re-prompts with a concrete example.
//
// The owner-typed-a-help-word case is filtered upstream by isHelpOrConfusion
// (see onboarding-help-words.ts), so this parser does not need its own
// blacklist.
const CBU_RE = /^\d{22}$/;
const ALIAS_FORMAT_RE = /^[a-zA-Z0-9._-]{3,20}$/;

export function detectTransferAlias(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  // Reject phrases: any whitespace disqualifies (alias has no spaces).
  if (/\s/.test(trimmed)) return null;
  // Pure numeric string: only a 22-digit CBU is valid.
  if (/^\d+$/.test(trimmed)) return CBU_RE.test(trimmed) ? trimmed : null;
  // Non-numeric: must match alias format AND contain a dot.
  if (ALIAS_FORMAT_RE.test(trimmed) && trimmed.includes(".")) return trimmed;
  return null;
}

// ── T4 (onboarding): código postal del negocio ────────────────────────────
// Reusa el mismo patrón que business-postal-reply-fast-path.ts (4-5 dígitos).
// Length cap is 30 (not 10) to allow "código postal 5500" prefix form.
const CP_RE = /^\d{4,5}$/;
const CP_EXTRACT_RE = /^(?:c[oó]digo\s+postal\s*:?\s*|cp\s*:?\s*)?(\d{4,5})$/i;

export function detectPostalCode(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length > 30) return null;
  const match = CP_EXTRACT_RE.exec(trimmed);
  if (!match) return null;
  return CP_RE.test(match[1]) ? match[1] : null;
}

// ── T5 (onboarding): preferencia de correo ────────────────────────────────
// "Correo" canonicalizes Correo Argentino — stored as "Correo" in
// Business.courierPreference; the credential matcher in load-context.ts
// lowercases both sides so "Correo" ↔ provider "correo" lines up.
export type CourierChoice = "Andreani" | "OCA" | "Correo" | "ninguno";

const COURIER_MAP: Record<string, CourierChoice> = {
  "andreani": "Andreani",
  "oca": "OCA",
  "correo": "Correo",
  "correo argentino": "Correo",
  "correo arg": "Correo",
  "no hago envios": "ninguno",
  "ninguno": "ninguno",
  "no envio": "ninguno",
  "no enviamos": "ninguno",
  "sin envios": "ninguno",
  "no despacho": "ninguno",
};

export function detectCourierChoice(text: string): CourierChoice | null {
  const normalized = normalizeForMatching(text).trim();
  if (!normalized) return null;
  const direct = COURIER_MAP[normalized];
  if (direct) return direct;
  if (/\bandreani\b/.test(normalized)) return "Andreani";
  if (/\boca\b/.test(normalized)) return "OCA";
  if (/\bcorreo\b/.test(normalized)) return "Correo";
  if (/\bno\b.*\benv[íi]o/.test(normalized) || /\bninguno\b/.test(normalized)) return "ninguno";
  return null;
}

// ── T6 (onboarding): WhatsApp del negocio ────────────────────────────────
// Acepta 10-13 dígitos, prefijo +54 / 54 opcional. Normaliza quitando + y espacios.
// El chip "Más tarde" → valor "wa_defer" se detecta separadamente.
const WA_RE = /^(?:\+?54)?(\d{10,11})$/;

export function detectWhatsappPhone(text: string): string | null {
  const trimmed = text.trim().replace(/[\s\-().]/g, "");
  if (!trimmed) return null;
  if (trimmed.length > 15) return null;
  const m = WA_RE.exec(trimmed);
  if (!m) return null;
  // Normalize: strip leading country code if present, keep 10-11 digit local number.
  return m[1] ?? trimmed;
}

// ── T6: conectar Mercado Pago ──────────────────────────────────────────────
export type T6Choice = "connect" | "defer";

const T6_CONNECT_VALUES = new Set(["connect_mp", "conectar", "si", "dale", "ahora"]);
const T6_DEFER_VALUES = new Set(["defer_mp", "mas tarde", "despues", "no", "skip"]);

export function detectT6Choice(text: string): T6Choice | null {
  const normalized = normalizeForMatching(text).trim();
  if (!normalized) return null;
  if (T6_CONNECT_VALUES.has(normalized)) return "connect";
  if (T6_DEFER_VALUES.has(normalized)) return "defer";
  return null;
}
