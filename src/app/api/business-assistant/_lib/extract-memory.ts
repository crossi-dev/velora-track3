import "server-only";
// Post-turn memory extractor for the Supervisor path.
// Analyses the owner's message after each turn and saves learned preferences
// to the Memory Bank (Vertex AI Agent Engine) for injection in future turns.
//
// Heuristics (v1 — expandable):
//   1. Explicit corrections  — "no, así no" / "te equivocaste" / "eso está mal"
//   2. Explicit preferences  — "respuestas más cortas" / "no uses tablas"
//   3. Rioplatense vocabulary — repeated domain-specific terms or names
//
// Designed to run fire-and-forget (void) after the response is sent.
// Never blocks the chat pipeline.

import { saveOwnerMemory, isMemoryBankEnabled } from "@/lib/agent-memory-bank";
import { saveEmployeeMemory } from "@/lib/agent-memory-bank.employee";

// ─── Correction patterns ─────────────────────────────────────────────────────

const CORRECTION_PATTERNS: RegExp[] = [
  /\b(no[,.]?\s+así\s+no|te\s+equivocaste|eso\s+está\s+mal|no\s+es\s+así|eso\s+no\s+es\s+correcto|no\s+lo\s+hagas?\s+así)/i,
  /\b(you('re|\s+are)\s+wrong|that('s|\s+is)\s+(not\s+right|wrong|incorrect)|don'?t\s+do\s+it\s+like\s+that)/i,
];

// ─── Preference patterns ─────────────────────────────────────────────────────

// Each entry: [detectionRegex, memory template fn]
const PREFERENCE_PATTERNS: Array<[RegExp, (match: RegExpMatchArray) => string]> = [
  [
    /\b(respuestas?\s+más\s+(cortas?|breves?|concisas?))/i,
    () => "Owner preference: keep answers short and concise",
  ],
  [
    /\b(short(er)?\s+(answers?|responses?)|be\s+brief|keep\s+it\s+(short|brief|concise))/i,
    () => "Owner preference: keep answers short and concise",
  ],
  [
    /\b(no\s+uses?\s+tablas?|sin\s+tablas?)/i,
    () => "Owner preference: avoid markdown tables in responses",
  ],
  [
    /\b(no\s+(tables?|markdown\s+tables?))/i,
    () => "Owner preference: avoid markdown tables in responses",
  ],
  [
    /\b(respondé?\s+en\s+ingl[eé]s|habla[me]?\s+en\s+ingl[eé]s)/i,
    () => "Owner preference: respond in English",
  ],
  [
    /\b(respond?\s+in\s+spanish|habla[me]?\s+en\s+espa[nñ]ol)/i,
    () => "Owner preference: respond in Spanish (Rioplatense)",
  ],
  [
    /\b(siempre\s+(pon[eé]|agrega[me]?|incluí?)\s+(?:el\s+)?precio|always\s+(add|include|show)\s+the\s+price)/i,
    () => "Owner preference: always include prices in product responses",
  ],
  [
    /\b(no\s+me\s+mandes?\s+notificaciones?|no\s+notifications?)/i,
    () => "Owner preference: suppress proactive notifications",
  ],
  [
    /\b(sin\s+emojis?|no\s+emojis?)/i,
    () => "Owner preference: no emojis in responses",
  ],
  [
    /\b(usá?\s+emojis?|use\s+emojis?|add\s+emojis?)/i,
    () => "Owner preference: use emojis in responses",
  ],
];

// ─── Extraction logic ────────────────────────────────────────────────────────

interface TurnContext {
  ownerText: string;
  supervisorAnswer: string;
  businessId: string;
}

function extractCorrection(text: string, supervisorAnswer: string): string | null {
  for (const re of CORRECTION_PATTERNS) {
    if (re.test(text)) {
      // Include a trimmed snapshot of the supervisor answer that was corrected.
      const preview = supervisorAnswer.slice(0, 120).replace(/\n+/g, " ").trim();
      return `Owner corrected supervisor: "${preview}" — context: "${text.slice(0, 80).trim()}"`;
    }
  }
  return null;
}

function extractPreferences(text: string): string[] {
  const found: string[] = [];
  for (const [re, template] of PREFERENCE_PATTERNS) {
    const match = text.match(re);
    if (match) found.push(template(match));
  }
  return found;
}

/**
 * Analyse one owner turn and fire-and-forget Memory Bank saves for any
 * learned preferences or corrections found.
 *
 * Called AFTER the response is sent — never awaited on the hot path.
 */
export async function extractAndSaveMemory(ctx: TurnContext): Promise<void> {
  if (!isMemoryBankEnabled()) return;

  const { ownerText, supervisorAnswer, businessId } = ctx;
  if (!ownerText.trim()) return;

  const toSave: string[] = [];

  const correction = extractCorrection(ownerText, supervisorAnswer);
  if (correction) toSave.push(correction);

  const prefs = extractPreferences(ownerText);
  toSave.push(...prefs);

  // Fire-and-forget each save independently — one failure doesn't block others.
  for (const content of toSave) {
    void saveOwnerMemory(businessId, content).catch(() => { /* fail-soft */ });
  }
}

// ─── Employee extraction ─────────────────────────────────────────────────────

// Employee-specific correction patterns (same structure as owner but labelled
// for the Companion so saved memories are distinguishable in the store).
const EMPLOYEE_CORRECTION_PATTERNS: RegExp[] = [
  /\b(no[,.]?\s+así\s+no|te\s+equivocaste|eso\s+está\s+mal|no\s+es\s+así|eso\s+no\s+es\s+correcto|no\s+lo\s+hagas?\s+así)/i,
  /\b(you('re|\s+are)\s+wrong|that('s|\s+is)\s+(not\s+right|wrong|incorrect)|don'?t\s+do\s+it\s+like\s+that)/i,
];

// Employee-specific preference patterns — covers operational preferences that
// are relevant for the Companion (conciseness, language, product presentation).
const EMPLOYEE_PREFERENCE_PATTERNS: Array<[RegExp, (match: RegExpMatchArray) => string]> = [
  [
    /\b(respuestas?\s+más\s+(cortas?|breves?|concisas?))/i,
    () => "Employee preference: keep answers short and concise",
  ],
  [
    /\b(short(er)?\s+(answers?|responses?)|be\s+brief|keep\s+it\s+(short|brief|concise))/i,
    () => "Employee preference: keep answers short and concise",
  ],
  [
    /\b(no\s+uses?\s+tablas?|sin\s+tablas?)/i,
    () => "Employee preference: avoid markdown tables in responses",
  ],
  [
    /\b(respondé?\s+en\s+ingl[eé]s|habla[me]?\s+en\s+ingl[eé]s)/i,
    () => "Employee preference: respond in English",
  ],
  [
    /\b(respond?\s+in\s+spanish|habla[me]?\s+en\s+espa[nñ]ol)/i,
    () => "Employee preference: respond in Spanish (Rioplatense)",
  ],
  [
    /\b(siempre\s+(pon[eé]|agrega[me]?|incluí?)\s+(?:el\s+)?precio|always\s+(add|include|show)\s+the\s+price)/i,
    () => "Employee preference: always include prices in product responses",
  ],
  [
    /\b(sin\s+emojis?|no\s+emojis?)/i,
    () => "Employee preference: no emojis in responses",
  ],
  [
    /\b(usá?\s+emojis?|use\s+emojis?|add\s+emojis?)/i,
    () => "Employee preference: use emojis in responses",
  ],
];

interface EmployeeTurnContext {
  employeeText: string;
  companionAnswer: string;
  businessId: string;
  employeeId: string;
}

function extractEmployeeCorrection(text: string, companionAnswer: string): string | null {
  for (const re of EMPLOYEE_CORRECTION_PATTERNS) {
    if (re.test(text)) {
      const preview = companionAnswer.slice(0, 120).replace(/\n+/g, " ").trim();
      return `Employee corrected companion: "${preview}" — context: "${text.slice(0, 80).trim()}"`;
    }
  }
  return null;
}

function extractEmployeePreferences(text: string): string[] {
  const found: string[] = [];
  for (const [re, template] of EMPLOYEE_PREFERENCE_PATTERNS) {
    const match = text.match(re);
    if (match) found.push(template(match));
  }
  return found;
}

/**
 * Analyse one employee turn and fire-and-forget Memory Bank saves for any
 * learned preferences or corrections found.
 * Scoped strictly to `employee:{businessId}:{employeeId}`.
 *
 * Called AFTER the Companion response is sent — never awaited on the hot path.
 */
export async function extractAndSaveEmployeeMemory(ctx: EmployeeTurnContext): Promise<void> {
  if (!isMemoryBankEnabled()) return;

  const { employeeText, companionAnswer, businessId, employeeId } = ctx;
  if (!employeeText.trim()) return;

  const toSave: string[] = [];

  const correction = extractEmployeeCorrection(employeeText, companionAnswer);
  if (correction) toSave.push(correction);

  const prefs = extractEmployeePreferences(employeeText);
  toSave.push(...prefs);

  // Fire-and-forget each save independently — one failure doesn't block others.
  for (const content of toSave) {
    void saveEmployeeMemory(businessId, employeeId, content).catch(() => { /* fail-soft */ });
  }
}
