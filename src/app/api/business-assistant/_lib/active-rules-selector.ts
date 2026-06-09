// active-rules-selector.ts — selects the single most relevant behavior rule for
// a given employee turn so the Companion can reinforce it proactively.
//
// Two public exports:
//   getActiveBusinessRules — Prisma query; call once per turn (cached in context)
//   selectRelevantRule     — pure heuristic; picks one rule or returns null

import { prisma } from "@/lib/prisma";
import { normalizeForMatching } from "@/lib/normalize";

export interface ActiveRule {
  id?: string;
  kind: string;
  trigger: string;
  message: string;
}

// ─── DB query ───────────────────────────────────────────────────────────────

/**
 * Returns active BusinessRules for a business filtered by kind.
 * Pass kind="behavior" to get only advisory behavior rules (the ones the
 * Companion can proactively surface).
 */
export async function getActiveBusinessRules(
  businessId: string,
  kind?: "behavior-based" | "condition-based" | "time-based",
): Promise<ActiveRule[]> {
  const rows = await prisma.businessRule.findMany({
    where: {
      businessId,
      active: true,
      ...(kind ? { kind } : {}),
    },
    select: { id: true, kind: true, trigger: true, message: true },
    orderBy: { createdAt: "asc" },
  });

  return rows;
}

// ─── Heuristic selector ──────────────────────────────────────────────────────

/**
 * Given a list of rules, the detected intent, and the raw user text, returns
 * the single most relevant rule the Companion should surface in this turn.
 *
 * Returns null when no rule is relevant (prevents noisy repetition).
 *
 * Scoring priority (highest first):
 *   1. Trigger keyword matches user text directly.
 *   2. Trigger keyword matches the intent string.
 *   3. Time-of-day relevance for greeting / closing rules.
 *
 * This is deliberately simple: keyword bag match, no LLM.
 */
export function selectRelevantRule(
  rules: ActiveRule[],
  intent: string,
  userText: string,
): ActiveRule | null {
  if (rules.length === 0) return null;

  const normalizedText = normalize(userText);
  const normalizedIntent = normalize(intent);

  // Candidate: { rule, score }
  let best: { rule: ActiveRule; score: number } | null = null;

  for (const rule of rules) {
    const triggerWords = extractTriggerWords(rule.trigger);
    let score = 0;

    // Direct text match: trigger words appear in the user message.
    const textHits = triggerWords.filter((w) => normalizedText.includes(w)).length;
    if (textHits > 0) score += textHits * 3;

    // Intent match: trigger words appear in the intent label.
    const intentHits = triggerWords.filter((w) => normalizedIntent.includes(w)).length;
    if (intentHits > 0) score += intentHits * 2;

    // Greeting-of-day rule (trigger contains "greet" / "salud" / "bienvenid"):
    // bump score when the employee message is short (likely a greeting).
    if (/\b(greet|salud|bienvenid|entrada|abrir|apertura)\b/.test(rule.trigger) &&
        normalizedText.length < 30) {
      score += 1;
    }

    // Closing rule (trigger contains "close" / "cierre" / "cierra" / "caja"):
    // bump when user message is about closing or end of shift.
    if (/\b(close|cierre|cierra|caja|conteo|fin.*turno|turno.*fin)\b/.test(rule.trigger) &&
        /\b(cierre|caja|turno|fin|cerrar)\b/.test(normalizedText)) {
      score += 1;
    }

    if (score === 0) continue;

    if (!best || score > best.score) {
      best = { rule, score };
    }
  }

  return best?.rule ?? null;
}

// ─── Private helpers ─────────────────────────────────────────────────────────

function normalize(text: string): string {
  // Delegates core NFKC→NFD→\p{M}→lowercase to the canonical normalizeForMatching.
  // Applies the [^a-z0-9\s_] → space step locally as it is specific to this
  // keyword-extraction context and not part of the shared contract.
  return normalizeForMatching(text).replace(/[^a-z0-9\s_]/g, " ");
}

/**
 * Extracts searchable keywords from a trigger string.
 * Handles formats: "greet_customer_entry", "no_sale_without_customer",
 * "credit_request", "ask_id_alcohol_sale", cron strings ("* * * * *" → skip).
 */
function extractTriggerWords(trigger: string): string[] {
  // Cron expressions have no useful keywords.
  if (/^[\d*/,\- ]+$/.test(trigger.trim())) return [];

  // Split on non-alphanumeric separators. normalizeForMatching handles NFKC→NFD→strip.
  const raw = normalizeForMatching(trigger)
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3);

  return raw;
}
