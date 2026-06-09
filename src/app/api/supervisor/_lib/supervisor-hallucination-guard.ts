import { cloudLog } from "@/lib/cloud-logger";
import {
  detectActionHallucination,
  HALLUCINATION_FALLBACK_ANSWER,
} from "@/app/api/business-assistant/_lib/answer-hallucination-guard";
import type { SupervisorResponse } from "./supervisor-response";

// Enforce vs shadow mode:
//   enforce → replace the answer with HALLUCINATION_FALLBACK_ANSWER and block
//             the action, mirroring the employee-side behavior. DEFAULT.
//   shadow  → log only, leave the answer untouched. Opt-in for observation
//             windows where you want to surface false positives in owner queries
//             (which are more analytical/historical than employee turns and may
//             legitimately contain past-tense verbs like "vendido", "registrado").
//
// Toggle: set HALLUCINATION_GUARD_MODE=shadow in Cloud Run env vars to demote.
// Default is "enforce" — this is the documented production behavior per CLAUDE.md.
//
// Re-evaluated per call (not module-load capture) so the flag can be toggled
// without redeploy (runtime feature flag pattern).
function getGuardMode(): "shadow" | "enforce" {
  return process.env.HALLUCINATION_GUARD_MODE === "shadow" ? "shadow" : "enforce";
}

// Neutral answer substituted when a hallucinated past-tense confirmation is
// detected inside a kind:"actions" response. The actions array is left intact
// (validated separately). This text MUST NOT claim the action completed —
// it only acknowledges receipt and defers confirmation to the action result.
const HALLUCINATION_ACTIONS_FALLBACK_ANSWER =
  "Pedido recibido — revisá el detalle de las acciones abajo.";

// Applies the hallucination guard to a parsed supervisor response.
//
// kind:"answer"  — scanned and (in enforce mode) replaced with
//                  HALLUCINATION_FALLBACK_ANSWER when a false-confirmation
//                  pattern is detected. No client-side action follows, so a
//                  hallucinated answer would mislead the owner with no recourse.
//
// kind:"actions" — the `answer` field is ALSO scanned. Prior to this fix it
//                  was deliberately skipped because the answer "describes work
//                  the client is about to dispatch". However that same answer
//                  can contain a hallucinated past-tense confirmation ("La venta
//                  quedó registrada") that the owner reads BEFORE any action
//                  executes. In enforce mode the answer is replaced with
//                  HALLUCINATION_ACTIONS_FALLBACK_ANSWER; the actions array is
//                  left untouched so the client still dispatches correctly.
//
// kind:"clarification" — clarification.question is ALSO scanned. Path Juan
//                  supervisor responses frequently take this shape, and a
//                  hallucinated past-tense confirmation inside a question string
//                  ("Ya lo registré. ¿Querés agregar otro?") is just as
//                  misleading as in a direct answer.
//
// kind:"notification" — not scanned (no free-text confirmation risk in that shape).
export function applySupervisorHallucinationGuard(
  parsed: Omit<SupervisorResponse, "usedModel">,
  context: { businessId?: string; usedModel?: string } = {},
): Omit<SupervisorResponse, "usedModel"> {
  // For clarification responses, scan the question string instead of answer.
  const clarificationQuestion =
    parsed.kind === "clarification" ? parsed.clarification?.question ?? null : null;
  const isGuardable =
    ((parsed.kind === "answer" || parsed.kind === "actions") && !!parsed.answer) ||
    (parsed.kind === "clarification" && !!clarificationQuestion);
  if (!isGuardable) return parsed;

  const textToScan =
    parsed.kind === "clarification" ? clarificationQuestion! : parsed.answer;
  const guard = detectActionHallucination(textToScan);
  if (!guard.matched) return parsed;

  const mode = getGuardMode();
  cloudLog({
    severity: "WARNING",
    component: "Supervisor",
    action: "SUPERVISOR_ANSWER_HALLUCINATION_DETECTED",
    a2a_transfer: false,
    message: `Supervisor answer matched hallucination pattern — kind=${parsed.kind} guard=${mode} (set HALLUCINATION_GUARD_MODE=shadow to demote to log-only)`,
    businessId: context.businessId ?? "",
    data: {
      kind: parsed.kind,
      mode,
      pattern: guard.patternName,
      usedModel: context.usedModel,
      originalAnswerPreview: textToScan.slice(0, 240),
    },
  });

  if (mode === "shadow") return parsed;

  // enforce mode: replace hallucinated text with a neutral non-confirming phrase.
  // For actions responses the actions array remains intact.
  // For clarification responses, replace the question string (not answer).
  if (parsed.kind === "clarification") {
    return {
      ...parsed,
      clarification: parsed.clarification
        ? { ...parsed.clarification, question: HALLUCINATION_FALLBACK_ANSWER }
        : parsed.clarification,
    };
  }
  const fallback =
    parsed.kind === "actions"
      ? HALLUCINATION_ACTIONS_FALLBACK_ANSWER
      : HALLUCINATION_FALLBACK_ANSWER;
  return { ...parsed, answer: fallback };
}
