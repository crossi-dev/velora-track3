// engine-factory.ts — Engine selection via ENGINE env var.
//
// Reads process.env.ENGINE at CALL TIME (not module-load time) so a future
// test or feature-flag can toggle the value without a module reload.
//
// Fail-loud on unknown values: a typo'd ENGINE must not silently fall back to
// Gemini.  Explicit-over-implicit (12-factor config, factor III: "Store config
// in the environment") means config errors should blow up at startup, not cause
// a silent wrong-provider run.
//
// Supported engines:
//   "gemini" (default) — GeminiAdapter (Vertex AI, @google/adk v1.1.0)
//   "openai"           — OpenAIAdapter (Chat Completions API); requires OPENAI_API_KEY
//   "claude"           — ClaudeAdapter (Anthropic Messages API); requires ANTHROPIC_API_KEY
//
// Adding a new engine:
//   1. Implement `src/lib/adk/adapters/<name>-adapter.ts`.
//   2. Add a branch below: case "<name>": return new YourAdapter({...}).
//   3. Add the string to SUPPORTED_ENGINES.

import type { BaseLlm } from "@google/adk";
import { GeminiAdapter } from "./adapters/gemini-adapter";
import { OpenAIAdapter } from "./adapters/openai-adapter";
import { ClaudeAdapter } from "./adapters/claude-adapter";
import { resolveEngineModel } from "./engine-model-map";

const SUPPORTED_ENGINES = ["gemini", "openai", "claude"] as const;
type SupportedEngine = (typeof SUPPORTED_ENGINES)[number];

export interface EngineModelOpts {
  model: string;
  project: string;
  location: string;
}

/**
 * Returns a BaseLlm instance for the active engine.
 *
 * ENGINE env var selects the engine; defaults to "gemini" when unset.
 * Throws on any unrecognised value — fail-loud, not silent-fallback.
 */
export function createEngineModel(opts: EngineModelOpts): BaseLlm {
  // Treat unset / blank / whitespace-only ENGINE as the default. `??` alone does
  // NOT catch the empty string, so an operator who sets `ENGINE=` on Cloud Run
  // would otherwise crash all agents — default it instead of throwing on blank.
  const raw = (process.env.ENGINE ?? "").trim() || "gemini";

  // Validate membership BEFORE the switch so the `never` exhaustiveness check in
  // the default branch stays meaningful (casting raw straight to SupportedEngine
  // would let TypeScript treat the default as dead code — see S3 JD finding).
  if (!(SUPPORTED_ENGINES as readonly string[]).includes(raw)) {
    throw new Error(
      `Unknown ENGINE="${raw}". Supported engines: ${SUPPORTED_ENGINES.join(", ")}.`,
    );
  }
  const engine = raw as SupportedEngine;

  switch (engine) {
    case "gemini":
      return new GeminiAdapter({
        model: opts.model,
        vertexai: true,
        project: opts.project,
        location: opts.location,
      });

    case "openai":
      // opts.model is a Gemini id — used only to pick the pro/flash tier, then
      // mapped to the equivalent OpenAI model (engine-model-map.ts). The Gemini
      // id itself is never sent to OpenAI. OPENAI_API_KEY must be set.
      // project + location are Gemini-specific — OpenAIAdapter ignores them.
      return new OpenAIAdapter({ model: resolveEngineModel("openai", opts.model) });

    case "claude":
      // opts.model is a Gemini id — used only to pick the pro/flash tier, then
      // mapped to the equivalent Claude model (engine-model-map.ts: Supervisor
      // → Sonnet, sub-agents → Haiku). Override per tier with ANTHROPIC_MODEL_*,
      // or force one model for all with ANTHROPIC_MODEL. ANTHROPIC_API_KEY required.
      return new ClaudeAdapter({ model: resolveEngineModel("claude", opts.model) });

    default: {
      const _exhaustive: never = engine;
      void _exhaustive;
      throw new Error(
        `Unknown ENGINE="${engine}". Supported engines: ${SUPPORTED_ENGINES.join(", ")}.`,
      );
    }
  }
}
