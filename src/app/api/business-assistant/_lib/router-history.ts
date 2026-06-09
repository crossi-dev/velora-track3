/**
 * router-history.ts — history-window helpers for the LLM router.
 *
 * Caps conversation history before it reaches the model to prevent token
 * overrun on long sessions. Flash has a tight context budget (1500 output
 * tokens); sending 50-turn histories wastes input tokens and risks exceeding
 * the per-call payload limit.
 *
 * MAX_HISTORY_TURNS=20 keeps the last 10 user+assistant pairs — enough for
 * continuity without ballooning the prompt.
 */

export const MAX_HISTORY_TURNS = 20;

export type HistoryEntry = { role: "user" | "assistant"; text: string };

/**
 * Truncates recentHistory to at most MAX_HISTORY_TURNS entries, keeping the
 * most recent ones. Turns are always kept in pairs (user → assistant) to
 * preserve conversational coherence; the window may be slightly smaller than
 * MAX_HISTORY_TURNS when the raw count is odd.
 */
export function truncateHistory(
  history: ReadonlyArray<HistoryEntry>,
  maxTurns: number = MAX_HISTORY_TURNS,
): Array<HistoryEntry> {
  if (history.length <= maxTurns) return [...history];
  // Take the last maxTurns entries. If that produces a leading assistant turn
  // (no prior user turn), drop one more to keep user-first ordering.
  const sliced = history.slice(-maxTurns);
  if (sliced.length > 0 && sliced[0].role === "assistant") {
    return sliced.slice(1);
  }
  return sliced;
}
