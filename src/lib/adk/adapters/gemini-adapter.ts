// gemini-adapter.ts — Gemini engine adapter (VeloraEngineAdapter implementation).
//
// 1:1 delegation to @google/adk Gemini — ZERO behaviour change.  Every call
// (generateContentAsync, connect, maybeAppendUserContent) is forwarded to the
// wrapped Gemini instance with the same arguments and the same return value.
//
// Why wrap instead of extending Gemini directly?
//   VeloraEngineAdapter is the stable Velora seam.  Extending Gemini would
//   couple Velora's adapter contract to ADK internals (protected fields, private
//   helpers) that are not part of the public API.  Composition keeps the seam
//   clean and lets us swap the delegate without changing the adapter's identity.
//
// LLMRegistry registration:
//   GeminiAdapter mirrors Gemini.supportedModels so that LLMRegistry.register()
//   can be called if string-model routing is needed.  Today registration is
//   NOT performed automatically — callers pass explicit instances from
//   gemini-config.ts.  Register only if your use-case requires model-string
//   routing through LLMRegistry.newLlm().
//
// ─────────────────────────────────────────────────────────────────────────────

import { Gemini } from "@google/adk";
import type { GeminiParams, BaseLlmConnection, LlmRequest, LlmResponse } from "@google/adk";
import { VeloraEngineAdapter } from "../engine-adapter";

export class GeminiAdapter extends VeloraEngineAdapter {
  /**
   * Mirrors Gemini.supportedModels for LLMRegistry compatibility.
   * Required by BaseLlmType so GeminiAdapter can be passed to LLMRegistry.register().
   */
  static readonly supportedModels: Array<string | RegExp> = Gemini.supportedModels;

  private readonly _gemini: Gemini;

  /**
   * @param params — Identical to GeminiParams accepted by new Gemini({...}).
   *   { model, vertexai, project, location, apiKey, headers }
   *   Passed through 1:1; no defaults added or overridden here.
   */
  constructor(params: GeminiParams) {
    // BaseLlm requires { model: string } in its constructor.
    // Gemini.model defaults to 'gemini-2.5-flash' when params.model is omitted;
    // we resolve it the same way by constructing Gemini first, then passing its
    // resolved model name up.
    const gemini = new Gemini(params);
    super({ model: gemini.model });
    this._gemini = gemini;
  }

  /**
   * Delegates to the wrapped Gemini.generateContentAsync — 1:1, same args, same yield.
   */
  generateContentAsync(
    llmRequest: LlmRequest,
    stream?: boolean,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, void> {
    return this._gemini.generateContentAsync(llmRequest, stream, abortSignal);
  }

  /**
   * Delegates to the wrapped Gemini.connect — 1:1, same arg, same promise.
   */
  connect(llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    return this._gemini.connect(llmRequest);
  }

  /**
   * Delegates maybeAppendUserContent to the wrapped Gemini.
   * BaseLlm provides a concrete implementation; we delegate to keep Gemini's
   * exact behaviour rather than relying on the inherited default.
   */
  override maybeAppendUserContent(llmRequest: LlmRequest): void {
    this._gemini.maybeAppendUserContent(llmRequest);
  }
}
