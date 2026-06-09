// Supervisor agent constants + timeout helper.
//
// Extracted from supervisor-agent.ts during the canonical Runner+sessionService
// refactor to keep the parent file under the 300-LOC contract.

import "server-only";
import { cloudLog } from "@/lib/cloud-logger";

export const SUPERVISOR_APP_NAME = "velora-supervisor-agent";

// B11 fix #4: derive ADK timeout from LLM budget so ADK_TIMEOUT < LLM_TIMEOUT holds.
// Env var SUPERVISOR_ADK_TIMEOUT_MS overrides. Falls back to derived value (default: 25s).
function deriveAdkTimeout(): number {
  const llm = Number(process.env.LLM_TIMEOUT_MS ?? "40000");
  const attempt = Number(process.env.SUPERVISOR_ATTEMPT_TIMEOUT_MS ?? "12000");
  const derived = llm - attempt - 3000;
  if (derived <= 0) {
    cloudLog({
      severity: "WARNING",
      component: "Supervisor",
      action: "SUPERVISOR_TIMEOUT_OVERFLOW",
      a2a_transfer: false,
      message: "deriveAdkTimeout: computed ≤ 0 — clamping to 15000",
      data: { llm, attempt, derived },
    });
    return 15000;
  }
  return derived;
}

export const SUPERVISOR_ADK_TIMEOUT_MS = Number(
  process.env.SUPERVISOR_ADK_TIMEOUT_MS ?? String(deriveAdkTimeout()),
);

/**
 * Maps a numeric thinking budget to the corresponding ThinkingLevel for the
 * gemini-3.x family. Used by the supervisor when the model is Gemini 3 — on
 * Gemini 2.5 the numeric budget is passed through unchanged.
 *
 * Canonical source — gemini-client.ts imports and re-uses this instead of
 * declaring its own copy (dedup 2026-05-29).
 *
 * Budget-to-level mapping:
 *   0 → MINIMAL, 1-999 → LOW, 1000-3999 → MEDIUM, 4000+ → HIGH
 */
export function budgetToLevel(budget: number): import("@google/genai").ThinkingLevel {
  // Inline import to avoid pulling ThinkingLevel into the top-level type space
  // when this helper is consumed from a non-3.x branch.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { ThinkingLevel } = require("@google/genai") as typeof import("@google/genai");
  if (budget === 0) return ThinkingLevel.MINIMAL;
  if (budget < 1000) return ThinkingLevel.LOW;
  if (budget < 4000) return ThinkingLevel.MEDIUM;
  return ThinkingLevel.HIGH;
}

// Names of the in-band delegation tools — aligned with INTENT_TO_AGENT in agent-call-actions.ts.
// call_equipo_agent + call_marketplace_agent ENCAJONADOS 2026-05-25.
// call_caja_agent added 2026-06-03: was missing, so usedAdkDelegation=false after
// a Caja tool call — executeAgentCallActions would run but INTENT_TO_AGENT has no
// "call_caja_agent" entry, so the call was a no-op. Adding it here sets
// usedAdkDelegation=true (prevents duplicate dispatch) and the ADK Pattern C
// accumulator injection path handles the result (Caja uses direct DB tools, no
// dataParts, so the accumulator stays empty — no functional change to Caja mutations).
export const DELEGATION_TOOL_NAMES: ReadonlySet<string> = new Set([
  "call_contador_agent",
  "call_ventas_agent",
  "call_payments_agent",
  "call_logistica_agent",
  "call_communications_agent",
  "call_customer_agent",
  "call_inventario_agent",
  "call_caja_agent",
]);
