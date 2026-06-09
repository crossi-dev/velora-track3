// supervisor-parser-coerce.ts
//
// Pre-Zod shape coercion for Supervisor responses. Recovers from common
// Gemini shape-drift patterns before strict validation rejects them.
//
// Extracted from supervisor-parser.ts to honor the 300-LOC area contract.

// Recover from common shape drift before zod validation:
//   - kind === null / undefined  but `clarification` populated → "clarification"
//   - kind === null              but `answer` populated         → "answer"
//   - kind === null              but `actions` populated        → "actions"
//   - kind === null              but `notification` populated   → "notification"
//   - kind === { type: "answer" } / { value: "..." }            → unwrap inner string
export function coerceKind(parsed: Record<string, unknown>): { changed: boolean; reason: string } {
  const k = parsed.kind;
  const VALID = ["actions", "clarification", "answer", "notification"] as const;

  if (typeof k === "string" && (VALID as readonly string[]).includes(k)) {
    return { changed: false, reason: "" };
  }

  if (k && typeof k === "object" && !Array.isArray(k)) {
    const ko = k as Record<string, unknown>;
    const inner = ko.type ?? ko.value ?? ko.kind ?? ko.reply;
    if (typeof inner === "string" && (VALID as readonly string[]).includes(inner)) {
      parsed.kind = inner;
      return { changed: true, reason: `unwrap_object_kind:${inner}` };
    }
    // {"kind":{"answer":"text"}} — model put the answer inside kind. Hoist it.
    if (typeof ko.answer === "string" && ko.answer.trim().length > 0) {
      parsed.answer = ko.answer;
      parsed.kind = "answer";
      return { changed: true, reason: "hoist_answer_from_kind" };
    }
    // {"kind":{"intent":"x","data":{...}}} — model put one action inside kind.
    if (typeof ko.intent === "string" && ko.data && !Array.isArray(parsed.actions)) {
      parsed.actions = [ko as Record<string, unknown>];
      parsed.kind = "actions";
      return { changed: true, reason: "wrap_action_from_kind" };
    }
    // {"kind":{"question":"...","context":"..."}} — clarification inside kind
    if (typeof ko.question === "string" && !parsed.clarification) {
      parsed.clarification = { question: String(ko.question), context: String(ko.context ?? "") } as Record<string, unknown>;
      parsed.kind = "clarification";
      return { changed: true, reason: "hoist_clarification_from_kind" };
    }
  }

  // {"kind":["clarification"], ...} — model occasionally arrays the kind value.
  if (Array.isArray(k) && k.length > 0 && typeof k[0] === "string" && (VALID as readonly string[]).includes(k[0] as string)) {
    parsed.kind = k[0];
    return { changed: true, reason: `unwrap_array_kind:${k[0]}` };
  }

  if (parsed.clarification && typeof parsed.clarification === "object") {
    parsed.kind = "clarification";
    return { changed: true, reason: "infer_from_clarification" };
  }
  if (Array.isArray(parsed.actions) && parsed.actions.length > 0) {
    parsed.kind = "actions";
    return { changed: true, reason: "infer_from_actions" };
  }
  if (parsed.notification && typeof parsed.notification === "object") {
    parsed.kind = "notification";
    return { changed: true, reason: "infer_from_notification" };
  }
  if (typeof parsed.answer === "string" && parsed.answer.trim().length > 0) {
    parsed.kind = "answer";
    return { changed: true, reason: "infer_from_answer" };
  }
  return { changed: false, reason: "irrecoverable" };
}
