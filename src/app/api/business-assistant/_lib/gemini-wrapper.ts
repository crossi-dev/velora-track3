// Gemini call wrapper. Velora runs on Google only (Gemini Pro Owner / Flash
// Employee). Anthropic Haiku was removed 2026-05-09 — see memory
// `feedback_model_order_google_first.md` for the rationale (dead quota,
// shape-drift maintenance burden, security-theater hedge at our scale).
//
// Previously named llm-router.ts — renamed 2026-05-23 because "router"
// implied vendor selection, but this is a single-vendor wrapper. The
// `usedModel: "gemini"` tag is intentional: telemetry consumers branch on
// it, and it makes the model provenance explicit at the call site.
//
// If you ever need real latency hedging, use Gemini Flash via the same SDK —
// keep this wrapper as the single Gemini entry point.

export type LLMCallResult = { text: string; usedModel: "gemini" };

export async function callGemini(
  geminiCall: () => Promise<string>,
): Promise<LLMCallResult> {
  const text = await geminiCall();
  return { text, usedModel: "gemini" };
}

/**
 * Detects a 429 rate-limit error from the Gemini/Vertex API.
 * Used by callSupervisor to decide whether to fall back to Flash instead of
 * retrying Pro (which would hit the same quota wall).
 */
export function isRateLimitError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return msg.includes("429") || msg.includes("quota") || msg.includes("rate limit") || msg.includes("resource_exhausted");
}
