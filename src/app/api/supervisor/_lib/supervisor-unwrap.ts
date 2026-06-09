// Double-wrap recovery helpers and shared parsing utilities for the Supervisor response.
// Extracted from supervisor-parser.ts to keep that file under the 300-LOC
// contract. Both helpers detect a known Gemini bug where the model emits a
// syntactically valid outer JSON whose `answer` field is itself the real
// structured response — either fenced as markdown or as a bare JSON string.
//
// tryUnwrapAnswerField: fast-path entry point used by supervisor-parser.ts to
// detect and recover double-wrap before Zod validation on the fast path.

import type { SupervisorNotification } from "@/lib/supervisor-types";

// Validate and coerce a raw notification object from the supervisor response.
// Kept here to free line budget in supervisor-parser.ts (300-LOC contract).
export function parseNotification(raw: unknown): SupervisorNotification | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const level = obj.level;
  if (level !== "now" && level !== "daily" && level !== "drop") return null;
  return {
    level,
    title: typeof obj.title === "string" ? obj.title.slice(0, 80) : "",
    body: typeof obj.body === "string" ? obj.body.slice(0, 200) : "",
    reason: typeof obj.reason === "string" ? obj.reason.slice(0, 200) : "",
  };
}

// Matches outermost markdown fence (```json, ```JSON, ``` with optional whitespace).
// Used to detect when the model wrapped its JSON response inside fences — either
// at the top-level raw string OR nested inside the `answer` field after a
// successful outer-JSON parse.
const FENCE_RE = /^\s*```(?:json)?\s*\n([\s\S]*?)\n\s*```\s*$/i;

// Attempt to extract and re-parse a fence-wrapped JSON string.
// Returns the parsed object if the string is a fence with valid JSON inside, null otherwise.
export function tryUnwrapFencedJson(value: string): Record<string, unknown> | null {
  const match = FENCE_RE.exec(value);
  if (!match) return null;
  const inner = match[1].trim();
  try {
    const reparsed = JSON.parse(inner);
    if (reparsed && typeof reparsed === "object" && !Array.isArray(reparsed)) {
      return reparsed as Record<string, unknown>;
    }
  } catch {
    // Not valid JSON inside the fence — ignore.
  }
  return null;
}

// Attempt to unwrap a JSON object string that the model placed inside `answer`
// WITHOUT markdown fences. Real production incident 2026-05-26 (Carlos audit):
//   {"kind":"answer","answer":"{\"kind\":\"answer\",\"answer\":\"El stock...\"}"}
// Outer parse succeeds; `answer` is a string that LOOKS like JSON but isn't
// fenced — tryUnwrapFencedJson misses it. We accept ONLY strings whose first
// non-space char is `{` AND that parse to an object with a recognized `kind`
// field (so plain text answers that happen to contain JSON syntax aren't
// mangled).
export function tryUnwrapJsonStringValue(value: string): Record<string, unknown> | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const reparsed = JSON.parse(trimmed);
    if (!reparsed || typeof reparsed !== "object" || Array.isArray(reparsed)) return null;
    const obj = reparsed as Record<string, unknown>;
    // Only unwrap when the inner JSON looks like a Supervisor response envelope.
    const VALID = ["actions", "clarification", "answer", "notification"];
    if (typeof obj.kind === "string" && VALID.includes(obj.kind)) {
      return obj;
    }
    return null;
  } catch {
    return null;
  }
}
