"use client";

import { tLang } from "./DashboardLangContext";

// ─── Speech error codes → localized messages ────────────────────────────────
// Used by the native (Capacitor) path. Web Speech API uses string codes
// instead, mapped inline. Called at error time (not module-load) so the
// language setting is read fresh on each invocation.
export function getSpeechError(code: number): string {
  const map: Record<number, string> = {
    1: tLang("Network error. Check your connection.", "Error de red. Verificá tu conexión."),
    2: tLang("Network error. Check your connection.", "Error de red. Verificá tu conexión."),
    3: tLang("Audio error. Try again.", "Error de audio. Intentá de nuevo."),
    4: tLang("Voice server error.", "Error del servidor de voz."),
    5: tLang("Internal error. Try again.", "Error interno. Intentá de nuevo."),
    6: tLang("No voice detected. Try again.", "No se detectó voz. Intentá de nuevo."),
    7: tLang("Could not understand. Try again.", "No se entendió. Intentá de nuevo."),
    8: tLang("Voice service busy. Try again in a few seconds.", "El servicio de voz está ocupado. Intentá en unos segundos."),
    9: tLang("Insufficient microphone permission.", "Permiso de micrófono insuficiente."),
  };
  return map[code] ?? tLang("Voice recognition error. Try again.", "Error de reconocimiento de voz. Intentá de nuevo.");
}

// ─── Types for Web Speech API ───────────────────────────────────────

export type SpeechRecognitionAlternativeLike = {
  transcript: string;
  confidence?: number;
};

export type SpeechRecognitionResultLike = {
  0: SpeechRecognitionAlternativeLike;
  isFinal?: boolean;
  length: number;
  [index: number]: SpeechRecognitionAlternativeLike;
};

export type SpeechRecognitionResultListLike = {
  length: number;
  [index: number]: SpeechRecognitionResultLike;
};

export type SpeechRecognitionEventLike = {
  resultIndex: number;
  results: SpeechRecognitionResultListLike;
};

export type SpeechRecognitionConstructor = new () => BrowserSpeechRecognition;

export interface BrowserSpeechRecognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives?: number;
  onend: (() => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  start: () => void;
  stop: () => void;
}

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  }
}

// ─── Shared helpers ─────────────────────────────────────────────────

export function normalizeVoiceTranscript(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

export function shouldAutoSendVoiceTranscript(
  value: string,
  options: { allowShortReply: boolean }
) {
  const normalized = normalizeVoiceTranscript(value);
  if (!normalized) return false;

  const normalizedLookup = normalized
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  const alphaNumericTokens = normalizedLookup.match(/[a-z0-9]+/g) ?? [];
  const compactAlphaNumeric = alphaNumericTokens.join("");

  if (!compactAlphaNumeric) return false;

  if (!options.allowShortReply) {
    if (compactAlphaNumeric.length <= 1) return false;
    if (alphaNumericTokens.length === 1 && alphaNumericTokens[0].length <= 2) return false;
    if (["eh", "emm", "em", "mmm", "mm", "este"].includes(normalizedLookup)) return false;
  }

  return true;
}
