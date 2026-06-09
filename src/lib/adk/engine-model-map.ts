// engine-model-map.ts — Maps Velora's per-agent Gemini model TIER to the
// equivalent model on a non-Gemini engine (Claude / OpenAI).
//
// Velora wires each agent with a Gemini model id (gemini-*-pro for the
// Supervisor, gemini-*-flash for Companion / Customer / sub-agents — see
// gemini-config.ts). When ENGINE selects a different engine, that Gemini id is
// meaningless to the provider, so we map the TIER (pro vs flash) to a sensible
// per-engine model instead of forwarding the Gemini id (which would otherwise
// be sent verbatim as a non-existent provider model).
//
// Tier detection mirrors resolveSubAgentLocation() in gemini-config.ts: a model
// whose id contains "pro" is the high-capability Supervisor tier; everything
// else (Flash) is the fast Companion / sub-agent tier.
//
// Defaults (verified against official pricing pages, HTTP 200 on 2026-06-03):
//   Claude — https://platform.claude.com/docs/en/about-claude/pricing
//     pro   → claude-sonnet-4-5   ($3 / $15 per MTok)
//     flash → claude-haiku-4-5    ($1 / $5  per MTok)
//   OpenAI — https://developers.openai.com/api/docs/pricing
//     pro   → gpt-5.5             ($5 / $30 per MTok)
//     flash → gpt-5.4-mini        ($0.75 / $4.50 per MTok)
//
// Overrides (all optional):
//   Per tier: ANTHROPIC_MODEL_PRO / ANTHROPIC_MODEL_FLASH
//             OPENAI_MODEL_PRO    / OPENAI_MODEL_FLASH
//   Force ONE model for every agent/tier (escape hatch — e.g. run the whole
//   fleet on Claude Opus): ANTHROPIC_MODEL / OPENAI_MODEL
// ─────────────────────────────────────────────────────────────────────────────

export type NonGeminiEngine = "claude" | "openai";
type Tier = "pro" | "flash";

/** Supervisor (Gemini Pro) → "pro"; Companion / Customer / sub-agents → "flash". */
function tierOf(geminiModel: string): Tier {
  return /pro/i.test(geminiModel) ? "pro" : "flash";
}

const DEFAULTS: Record<NonGeminiEngine, Record<Tier, string>> = {
  claude: { pro: "claude-sonnet-4-5", flash: "claude-haiku-4-5" },
  openai: { pro: "gpt-5.5", flash: "gpt-5.4-mini" },
};

/** Env var that, when set, forces a single model across ALL tiers for an engine. */
const FORCE_ENV: Record<NonGeminiEngine, string> = {
  claude: "ANTHROPIC_MODEL",
  openai: "OPENAI_MODEL",
};

/** Per-tier override env vars. */
const TIER_ENV: Record<NonGeminiEngine, Record<Tier, string>> = {
  claude: { pro: "ANTHROPIC_MODEL_PRO", flash: "ANTHROPIC_MODEL_FLASH" },
  openai: { pro: "OPENAI_MODEL_PRO", flash: "OPENAI_MODEL_FLASH" },
};

/**
 * Resolves the engine-specific model for a given agent.
 *
 * @param engine       The non-Gemini engine selected via ENGINE.
 * @param geminiModel  The Gemini model id the agent was wired with (used only
 *                     to detect the pro/flash tier — never sent to the engine).
 *
 * Precedence: force-all env > per-tier env > built-in default.
 */
export function resolveEngineModel(engine: NonGeminiEngine, geminiModel: string): string {
  const forced = process.env[FORCE_ENV[engine]]?.trim();
  if (forced) return forced;

  const tier = tierOf(geminiModel);
  const perTier = process.env[TIER_ENV[engine][tier]]?.trim();
  return perTier || DEFAULTS[engine][tier];
}
