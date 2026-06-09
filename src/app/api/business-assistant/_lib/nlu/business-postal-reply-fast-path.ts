// Business Postal Reply Fast Path — deterministic NLU for the owner's reply
// when Velora asks for the business postal code (or destination postal code).
//
// Context: when an owner requests a payment link WITH shipping but a postal
// code is missing (business CP or destination CP), the system asks for it.
// The owner's next message is a bare 4-5 digit postal code.
//
// Detector fires ONLY when BOTH conditions hold:
//   1. The current message looks like a bare postal code (4-5 digits, optionally
//      labelled with "CP" / "código postal").
//   2. The most recent assistant turn in recentHistory contains ANY of the
//      POSTAL_QUESTION_MARKERS phrases — i.e. Velora just asked.
//
// The marker set covers both the hardcoded fast-path question ("código postal
// de tu negocio") AND LLM-composed variants that the Supervisor may emit when
// the customer/destination postal code is missing ("código postal de destino",
// "necesito el código postal", etc.).
//
// This dual guard prevents bare numbers in unrelated conversations from being
// hijacked as postal codes.

import { normalizeForMatching } from "../shared";
import { cloudLog } from "@/lib/cloud-logger";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface BusinessPostalReplyIntent {
  kind: "business_postal_reply";
  /** The validated postal code string (4-5 digits, trimmed). */
  postalCode: string;
  /**
   * True when the canonical "código postal de tu negocio" marker fired — the CP
   * belongs to the business (origin). False when a destination-CP marker fired —
   * the CP belongs to the active customer (destination).
   */
  isCanonical: boolean;
  /** The exact marker phrase that matched, for logging / debugging. */
  matchedMarker: string;
}

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * @deprecated Use POSTAL_QUESTION_MARKERS array instead. Kept for backward
 * compatibility with any external import that reads the canonical hardcoded phrase.
 */
export const POSTAL_QUESTION_MARKER = "código postal de tu negocio";

/**
 * Full set of marker phrases that indicate Velora just asked for a postal code.
 *
 * Entry 0 is the canonical phrase injected by executePaymentLinkFastPath (must
 * match execute-payment-link-fast-path.ts copy exactly).
 * Remaining entries are LLM-composed variants the Supervisor may emit when the
 * destination / customer postal code is missing.
 *
 * All matching is done case-insensitively on the raw text; normalizeForMatching
 * is applied in parallel for diacritic-stripped history entries.
 */
export const POSTAL_QUESTION_MARKERS: readonly string[] = [
  "código postal de tu negocio",     // canonical — hardcoded fast path
  "código postal de destino",        // Supervisor: destination CP missing
  "código postal del envío",         // Supervisor: shipping CP variant
  "código postal de envío",          // Supervisor: shipping CP variant (no article)
  "necesito el código postal",       // Supervisor: generic ask
  "qué código postal",               // Supervisor: question form
  "cuál es el código postal",        // Supervisor: question form (full)
] as const;

/**
 * Normalised (diacritic-stripped) forms of POSTAL_QUESTION_MARKERS for
 * scanning history entries that may have been normalised before storage.
 * Uses normalizeForMatching (NFKC→NFD→\p{M} strip) — same pipeline as all
 * other NLU lookup paths in this module.
 */
const POSTAL_QUESTION_MARKERS_NORM: readonly string[] =
  POSTAL_QUESTION_MARKERS.map((m) => normalizeForMatching(m));

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Accepts messages of the form:
 *   "5500"
 *   "CP 1043"
 *   "código postal 5500"
 *   "cp: 5500"
 *
 * Rejects anything longer than ~30 chars (it's a clarification reply, not prose).
 *
 * Returns the extracted digits string or null.
 */
const BARE_CP_RE = /^(?:c[oó]digo\s+postal\s*:?\s*|cp\s*:?\s*)?(\d{4,5})$/i;

function extractPostalCodeFromMessage(text: string): string | null {
  const trimmed = text.trim();
  // Hard length cap: any message over 30 chars is not a bare CP reply.
  if (trimmed.length > 30) return null;
  const match = BARE_CP_RE.exec(trimmed);
  return match?.[1] ?? null;
}

/**
 * Scans the most recent assistant turn in recentHistory for ANY of the
 * POSTAL_QUESTION_MARKERS phrases (case-insensitive, diacritic-tolerant).
 *
 * Returns `{ marker, isCanonical }` when a match is found so the executor can
 * branch on whether the CP is for the business (origin) or the customer (destination).
 * Returns null when no marker is found.
 */
function matchMarkerInLastAssistantTurn(
  recentHistory: Array<{ role: "user" | "assistant"; text: string }>,
): { marker: string; isCanonical: boolean } | null {
  if (!recentHistory || recentHistory.length === 0) return null;
  // Walk from the end of history looking for the last assistant message.
  for (let i = recentHistory.length - 1; i >= 0; i--) {
    const entry = recentHistory[i];
    if (entry.role !== "assistant") continue;
    const raw = entry.text ?? "";
    const rawNorm = normalizeForMatching(raw);

    for (let j = 0; j < POSTAL_QUESTION_MARKERS.length; j++) {
      const marker = POSTAL_QUESTION_MARKERS[j];
      const markerNorm = POSTAL_QUESTION_MARKERS_NORM[j];
      if (raw.includes(marker) || rawNorm.includes(markerNorm)) {
        const isCanonical = j === 0;
        cloudLog({
          severity: "INFO",
          component: "Supervisor",
          action: "POSTAL_REPLY_FAST_PATH_MARKER_HIT",
          a2a_transfer: false,
          message: `Postal reply fast path triggered by marker: "${marker}"`,
          data: { matchedMarker: marker, isCanonical },
        });
        return { marker, isCanonical };
      }
    }
    // Only inspect the MOST RECENT assistant turn — stop after finding one.
    break;
  }
  return null;
}

// ── Detector ──────────────────────────────────────────────────────────────────

/**
 * Detects an owner reply containing a postal code, when Velora just asked for it.
 *
 * @param text   The raw owner message.
 * @param recentHistory  Recent turns from PreModelIntentParams.recentHistory.
 * @returns BusinessPostalReplyIntent when both conditions hold, null otherwise.
 *          The returned intent carries `isCanonical` and `matchedMarker` so the
 *          executor can route the CP to the correct table (Business vs Customer).
 */
export function detectBusinessPostalReply(
  text: string,
  recentHistory: Array<{ role: "user" | "assistant"; text: string }>,
): BusinessPostalReplyIntent | null {
  const postalCode = extractPostalCodeFromMessage(text);
  if (!postalCode) return null;

  const markerMatch = matchMarkerInLastAssistantTurn(recentHistory);
  if (!markerMatch) return null;

  return {
    kind: "business_postal_reply",
    postalCode,
    isCanonical: markerMatch.isCanonical,
    matchedMarker: markerMatch.marker,
  };
}
