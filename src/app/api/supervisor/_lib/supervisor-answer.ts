/**
 * supervisorAnswer — maps SupervisorResponse to { text, chips? }.
 *
 * Extracted from supervisor-runner.ts (Step 3 Round 2, JD CRITICAL #2) to keep
 * supervisor-runner.ts under the 300-line server contract.
 *
 * Null result → warm clarification per Dialogflow CX slot-filling + Wiesinger §3.3.
 * chips field is populated only on the null/clarification paths so they reach the UI.
 *
 * BREAKING CHANGE: return type changed from `string` to SupervisorAnswerResult.
 * Callers must destructure: `const { text, chips } = supervisorAnswer(...)`.
 * Backward-compat: `.text` mirrors the old return value; no callers lose data.
 *
 * References:
 *   - Dialogflow CX slot filling: https://cloud.google.com/dialogflow/cx/docs/concept/agent-design
 *   - Wiesinger §3.3 self-correction: https://www.kaggle.com/whitepaper-agents
 */

import { buildClarification, toClarificationChipsBundle } from "@/lib/clarification-fallback";
import type { ClarificationChipsBundle, ClarificationContext } from "@/lib/clarification-fallback";
import type { SupervisorResponse } from "./supervisor-response";

export type { ClarificationChipsBundle };

export interface SupervisorAnswerResult {
  text: string;
  chips?: ClarificationChipsBundle;
}

/**
 * Maps SupervisorResponse to { text, chips? }.
 *
 * @param sup - Supervisor response or null (null triggers clarification path).
 * @param rawText - Original user text; used as fallback ClarificationContext when ctx absent.
 * @param ctx - Optional pre-built ClarificationContext from buildClarificationContext (async).
 *   When provided, all five fields are populated so the correct clarification branch fires.
 *   When absent, only rawText is used (total fallback branch fires — Wiesinger §3.3).
 *
 * Callers that know the businessId SHOULD call buildClarificationContext first and pass ctx
 * so entity echoes and capability-gap chips appear (CRITICAL #1 wiring requirement).
 */
export function supervisorAnswer(
  sup: SupervisorResponse | null,
  rawText = "",
  ctx?: ClarificationContext,
): SupervisorAnswerResult {
  if (!sup) {
    const clarification = buildClarification(ctx ?? { rawText });
    return {
      text: clarification.text,
      chips: toClarificationChipsBundle(clarification.chips) ?? undefined,
    };
  }
  if (sup.kind === "answer" && sup.answer) return { text: sup.answer };
  if (sup.kind === "clarification" && sup.clarification?.question) {
    return { text: sup.clarification.question };
  }
  if (sup.kind === "actions") {
    return { text: sup.answer || "" };
  }
  return { text: sup.answer || "No pude procesar el pedido." };
}
