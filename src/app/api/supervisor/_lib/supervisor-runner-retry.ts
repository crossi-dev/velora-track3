// supervisor-runner-retry.ts
//
// Self-correction retry layer for SUPERVISOR_SCHEMA_INVALID failures.
//
// When the ADK path (InMemoryRunner) returns JSON that passes JSON.parse but
// fails Zod validation, safeParseJson() returns null. Rather than immediately
// returning an apology, this module re-prompts the LLM once with the Zod
// error appended to the user message — a documented ADK self-correction pattern.
//
// Sources:
//   ADK validation patterns: https://adk.dev
//   Wiesinger et al. §4.1 "Self-correction loops: re-prompting with structured
//   error feedback is a documented mitigation for schema non-compliance."
//   https://www.kaggle.com/whitepaper-agents

import { cloudLog } from "@/lib/cloud-logger";
import type { SupervisorResponse } from "./supervisor-response";
import type { SupervisorCallContext } from "./supervisor-context-builder";
import { safeParseJson } from "./supervisor-parser";
import { applySupervisorHallucinationGuard } from "./supervisor-hallucination-guard";
import { supervisorResponseSchema } from "./supervisor-schema";

// One re-prompt max. Wiesinger et al. §4.1: a single correction pass avoids
// infinite loops; further retries signal a structural prompt mismatch that
// needs human review, not more retry budget.
export const SCHEMA_VIOLATION_RETRY_LIMIT = 1;

/**
 * Attempt one schema-correction retry.
 *
 * Precondition: first-attempt raw was JSON-shaped (starts with '{') but
 * safeParseJson returned null (i.e., Zod validation failed).
 *
 * Returns the parsed+guarded response on success, null if retry also fails.
 * The returned object includes capturedPatternCIntents from the RETRY call so
 * the caller can propagate them correctly (the outer call's intents may be
 * empty or stale when the delegation happened inside the retry).
 */
export async function trySupervisorSchemaRetry(
  raw: string,
  text: string,
  context: SupervisorCallContext,
  callSupervisor: (
    text: string,
    context: SupervisorCallContext,
    opts?: { forceGeminiDirect?: boolean },
  ) => Promise<{ raw: string; usedModel: "gemini"; usedAdkDelegation: boolean; capturedPatternCIntents: Array<{ intent: string; data: unknown; summary: string }> }>,
): Promise<(Omit<SupervisorResponse, "usedModel" | "usedAdkDelegation"> & { capturedPatternCIntents: Array<{ intent: string; data: unknown; summary: string }> }) | null> {
  // Extract the Zod issues from a trial parse so we can include them in the
  // correction prompt — gives the model a concrete error signal.
  let zodIssues = "schema validation failure (Zod)";
  try {
    const candidate = JSON.parse(raw) as unknown;
    const result = supervisorResponseSchema.safeParse(candidate);
    if (!result.success) {
      zodIssues = result.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ");
    }
  } catch {
    // raw is not valid JSON after all — no retry value
    return null;
  }

  const correctionSuffix =
    `\n\n[SCHEMA CORRECTION REQUIRED — previous response failed validation: ${zodIssues}. ` +
    `Respond with a valid JSON object matching the required schema exactly. ` +
    `Do not add extra fields or omit required ones.]`;

  cloudLog({
    severity: "INFO",
    component: "Supervisor",
    action: "SUPERVISOR_SCHEMA_RETRY",
    a2a_transfer: false,
    message: "Attempting schema-correction retry (SCHEMA_VIOLATION_RETRY_LIMIT=1)",
    data: { zodIssues },
  });

  try {
    const retry = await callSupervisor(text + correctionSuffix, context);
    const retryParsed = safeParseJson(retry.raw);
    if (!retryParsed) return null;
    const guarded = applySupervisorHallucinationGuard(retryParsed, { usedModel: retry.usedModel });
    // Thread the RETRY's own capturedPatternCIntents through. If the delegation
    // happened inside the retry (not the outer first-attempt), the outer
    // capturedPatternCIntents is empty and the retry's intents must win.
    return { ...guarded, capturedPatternCIntents: retry.capturedPatternCIntents };
  } catch {
    return null;
  }
}
