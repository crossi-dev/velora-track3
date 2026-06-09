/**
 * STT (speech-to-text) normalization pipeline for Velora voice input.
 * Single entry point — all voice transcript cleaning passes through here.
 */

import { normalizeForMatching } from "@/lib/normalize";

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Collapses progressive speech-to-text restarts (n-gram deduplication).
 * Mirrors the server copy in src/app/api/business-assistant/_lib/shared.ts.
 * n-gram cap MUST stay at 20 to match.
 */
function collapseSpeechRepetition(text: string): string {
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  if (words.length < 2) return text;

  const normalized = words.map((w) =>
    normalizeForMatching(w).replace(/[^\p{L}\p{N}]/gu, "")
  );
  const drop = new Set<number>();

  for (let i = 0; i < words.length; i += 1) {
    if (drop.has(i)) continue;
    for (let n = Math.min(20, Math.floor((words.length - i) / 2)); n >= 1; n -= 1) {
      let match = true;
      for (let k = 0; k < n; k += 1) {
        const a = normalized[i + k];
        const b = normalized[i + n + k];
        if (!a || !b || a !== b) { match = false; break; }
      }
      if (match) {
        for (let k = 0; k < n; k += 1) drop.add(i + k);
        i += n - 1;
        break;
      }
    }
  }

  if (drop.size === 0) return text;
  return words.filter((_, idx) => !drop.has(idx)).join(" ");
}

/**
 * Full STT normalization pipeline. Accepts raw voice transcription and
 * returns a cleaned string ready for command parsing.
 *
 * Steps: whitespace collapse → speech-restart deduplication.
 * Number conversion and contraction resolution are handled by the Gemini 2.5 Flash
 * (Companion) system prompt directly; transforming them here would double-convert.
 */
export function normalizeSpeechInput(raw: string): string {
  return collapseSpeechRepetition(collapseWhitespace(raw));
}
