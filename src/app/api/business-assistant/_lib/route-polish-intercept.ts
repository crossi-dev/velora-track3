// Polish intercept for the business-assistant respond() function.
// Extracted from route.ts to keep that file ≤ 300 LOC.
//
// Pattern: Google ADK SequentialAgent "Generator → Refinement" post-processing,
// + Vercel AI SDK v5 `streamText` onFinish transform. Fires AFTER
// patchEmptyAnswer and BEFORE scheduleReplyPersist so the persisted text
// matches what the client receives.
//
// Refs:
//   https://google.github.io/adk-docs/agents/workflow-agents/sequential-agents/
//   https://sdk.vercel.ai/docs/reference/ai-sdk-core/stream-text

import { NextResponse } from "next/server";
import { polishReply } from "./reply-polish";

// Re-exported so route.ts can pull both response-assembly seams from one import
// (the file-size gate counts every import line). attachOwnerReadWidget attaches
// the slice-2 generative-UI widget; it lives in widget-builder.ts.
export { attachOwnerReadWidget } from "./widget-builder";

export interface PolishInterceptResult {
  respBody: Record<string, unknown>;
  finalResponse: NextResponse;
}

/**
 * Runs the polish layer on a 2xx response body's `answer` field. Falls back
 * to the original response on any failure (polishReply itself is fail-open).
 *
 * Internal flags (`_fromLlmSlowPath`, `intentKind`) are stripped from the
 * outgoing body whether or not polish fires.
 */
export async function runPolishIntercept(
  patched: NextResponse,
  respBody: Record<string, unknown>,
  status: number,
  businessId: string,
): Promise<PolishInterceptResult> {
  if (
    !(status >= 200 && status < 300) ||
    typeof respBody.answer !== "string" ||
    !respBody.answer
  ) {
    return { respBody, finalResponse: patched };
  }

  // LLM slow-path handlers set `_fromLlmSlowPath: true` so already-warm text
  // isn't re-polished (would add latency + drift).
  const skipPolish = (respBody._fromLlmSlowPath as boolean | undefined) === true;
  const intentKind =
    typeof respBody.intentKind === "string" ? respBody.intentKind : "unknown";

  const polished = await polishReply({
    fallbackText: respBody.answer as string,
    kind: "general",
    intentKind,
    businessId,
    skipPolish,
  });

  // Strip internal flags; merge polished answer; re-serialize response.
  const {
    _fromLlmSlowPath: _drop1,
    intentKind: _drop2,
    ...cleanBody
  } = respBody;
  void _drop1;
  void _drop2;
  const nextBody = { ...cleanBody, answer: polished };
  return { respBody: nextBody, finalResponse: NextResponse.json(nextBody, { status }) };
}
