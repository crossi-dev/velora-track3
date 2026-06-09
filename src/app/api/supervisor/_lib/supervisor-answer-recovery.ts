// supervisor-answer-recovery.ts
//
// Last-resort recovery for the ADK "answer-buried-in-actions" shape drift.
//
// Root cause: ADK's InMemoryRunner does NOT accept `responseSchema` inside
// `generateContentConfig` (see supervisor-agent.ts:19-26). When USE_ADK=true
// (production default) the model's output is NOT schema-enforced and
// occasionally emits a response where:
//   - `kind` is null or missing
//   - `answer` is empty or missing
//   - the actual reply text lives inside `actions[0].data.text` (or .message / .answer)
//
// Example (real ADK output 2026-05-27):
//   {"actions":[{"type":"reply","data":{"text":"Hola Carlos, ¿en qué te ayudo?"}}],"kind":null}
//
// This helper is a PURE FUNCTION — no I/O, no logging, no side effects.
// Call it AFTER the existing fence-strip / double-wrap unwrap chain but
// BEFORE the SUPERVISOR_SCHEMA_VIOLATION log/return-null point.
//
// Extracted into a sibling _lib file to stay under the 300-LOC contract
// for supervisor-parser.ts (which was at 279 lines before this change).

/** Minimal recovered shape returned to the caller for further Zod validation. */
export interface RecoveredAnswer {
  kind: "answer";
  answer: string;
  actions: null;
}

/**
 * Attempt to recover a plain-text answer from an `actions` array when the
 * top-level `answer` field is absent and `kind` is null / missing.
 *
 * Extraction priority (first match wins):
 *   1. `action.data` is a non-empty string
 *   2. `action.data.text` is a non-empty string
 *   3. `action.data.message` is a non-empty string
 *   4. `action.data.answer` is a non-empty string
 *
 * Returns null when:
 *   - `parsed` is not an object
 *   - top-level `answer` is already a non-empty string (no recovery needed)
 *   - `actions` is empty or not an array
 *   - none of the supported data shapes carries text
 */
export function tryRecoverAnswerFromActions(parsed: unknown): RecoveredAnswer | null {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;

  const obj = parsed as Record<string, unknown>;

  // Guard: if there is already a usable top-level answer, let the normal path
  // handle it — recovery is unnecessary and could mask real structure.
  if (typeof obj.answer === "string" && obj.answer.trim().length > 0) return null;

  // Guard: kind must be absent/null (not a valid recognised value).
  const VALID_KINDS = ["actions", "clarification", "answer", "notification"] as const;
  if (typeof obj.kind === "string" && (VALID_KINDS as readonly string[]).includes(obj.kind)) {
    return null;
  }

  // Guard: actions must be a non-empty array.
  if (!Array.isArray(obj.actions) || obj.actions.length === 0) return null;

  for (const action of obj.actions) {
    if (!action || typeof action !== "object" || Array.isArray(action)) continue;
    const act = action as Record<string, unknown>;

    // Shape 1: data is a bare string
    if (typeof act.data === "string" && act.data.trim().length > 0) {
      return { kind: "answer", answer: act.data.trim(), actions: null };
    }

    // Shapes 2-4: data is an object with text / message / answer
    if (act.data && typeof act.data === "object" && !Array.isArray(act.data)) {
      const d = act.data as Record<string, unknown>;
      const text =
        (typeof d.text === "string" && d.text.trim())     ||
        (typeof d.message === "string" && d.message.trim()) ||
        (typeof d.answer === "string" && d.answer.trim());

      if (text) {
        return { kind: "answer", answer: text, actions: null };
      }
    }
  }

  return null;
}
