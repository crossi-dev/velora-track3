// engine-adapter.ts — Engine-agnostic seam for Velora's ADK agent layer.
//
// This abstract class is the single extension point that decouples agent
// configuration from the underlying LLM engine.  Today Gemini is the ONLY
// concrete implementation (GeminiAdapter, S2).  Future engines (e.g. Codex,
// Cowork, or any other BaseLlm provider) implement this class and a
// Content[]↔provider translation layer — nothing else in the codebase changes.
//
// Design source:
//   @google/adk v1.1.0 BaseLlm (models/base_llm.d.ts) — abstract members are
//   generateContentAsync + connect + (non-abstract) maybeAppendUserContent.
//   VeloraEngineAdapter extends BaseLlm: any subclass is structurally compatible
//   with the ADK Agent `model` field (typed BaseLlm).
//
// ─── How to add a new engine (S4+) ──────────────────────────────────────────
//
//   1. Create `src/lib/adk/adapters/<engine>-adapter.ts`.
//   2. Extend VeloraEngineAdapter (not BaseLlm directly) so Velora conventions
//      (tracing hooks, etc.) can be added here without touching each adapter.
//   3. Implement generateContentAsync + connect, translating the provider's
//      native request/response shapes to LlmRequest / LlmResponse / BaseLlmConnection.
//   4. Call LLMRegistry.register(YourAdapter) if you want string-model routing.
//   5. Export a factory helper from gemini-config.ts (or a peer config file).
//
// ─────────────────────────────────────────────────────────────────────────────

import { BaseLlm } from "@google/adk";
import type { BaseLlmConnection, LlmRequest, LlmResponse } from "@google/adk";

/**
 * Abstract base for all Velora LLM engine adapters.
 *
 * Extends ADK's BaseLlm so every adapter is drop-in compatible with ADK's
 * Agent `model` field.  Concrete subclasses must implement the two abstract
 * ADK members declared below — both signatures are sourced verbatim from the
 * installed @google/adk v1.1.0 base_llm.d.ts.
 */
export abstract class VeloraEngineAdapter extends BaseLlm {
  /**
   * Generates content from the given LLM request.
   *
   * Signature sourced from BaseLlm.d.ts (@google/adk v1.1.0):
   *   generateContentAsync(
   *     llmRequest: LlmRequest,
   *     stream?: boolean,
   *     abortSignal?: AbortSignal
   *   ): AsyncGenerator<LlmResponse, void>
   */
  abstract generateContentAsync(
    llmRequest: LlmRequest,
    stream?: boolean,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, void>;

  /**
   * Creates a live (streaming) connection to the underlying LLM.
   *
   * Signature sourced from BaseLlm.d.ts (@google/adk v1.1.0):
   *   connect(llmRequest: LlmRequest): Promise<BaseLlmConnection>
   */
  abstract connect(llmRequest: LlmRequest): Promise<BaseLlmConnection>;
}
