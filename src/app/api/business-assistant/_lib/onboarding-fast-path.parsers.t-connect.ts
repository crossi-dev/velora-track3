// Shared parser for binary connect/defer onboarding turns (T13 ARCA, T14 Andreani).
// Pure — no context reads, no DB writes.

import { normalizeForMatching } from "@/lib/normalize";

export type ConnectChoice = "connect" | "defer";

const CONNECT_VALUES = new Set([
  "arca_connect",
  "andreani_connect",
  "conectar afip",
  "conectar andreani",
  "conectar",
  "si",
  "dale",
  "ahora",
  "cargarlo ahora",
  "si las cargo ahora",
]);

const DEFER_VALUES = new Set([
  "arca_defer",
  "andreani_defer",
  "mas tarde",
  "mas adelante",
  "despues",
  "no",
  "no por ahora",
  "skip",
  "saltear",
  "saltar",
]);

export function detectConnectChoice(text: string): ConnectChoice | null {
  const normalized = normalizeForMatching(text).trim();
  if (!normalized) return null;
  if (CONNECT_VALUES.has(normalized)) return "connect";
  if (DEFER_VALUES.has(normalized)) return "defer";
  return null;
}
