// agent-factory.seams.ts — Cross-cutting concern helpers baked into createAdkAgent.
//
// Four systemic patterns found across ALL 7 Velora agents (audit 2026-06-03):
//
//   P1  DB-first money guard — never trust an LLM-emitted price/amount; always
//       prefer the DB value. Generalised from the supervisor money-guard pattern.
//       Token-match algorithm lives in src/lib/money/user-typed-amount.ts (single
//       source of truth shared with supervisor-action-mapper.money-guard.ts).
//       Source: Intuit GenAI Safety §4 "Trust your own data systems, not the LLM".
//       https://www.kaggle.com/whitepaper-agents §3.3 (tool results are authoritative).
//
//   P2  PROHIBICIONES block — a numbered, non-negotiable instruction block injected
//       into the system prompt. Pattern mirrors the createTool prohibitions seam
//       in create-a2a-agent-tool.ts. Sourced from Google safety guidelines 2026:
//       https://ai.google.dev/gemini-api/docs/system-instructions
//
//   P3  HITL draft→approve seam — marks mutations as "requires explicit owner
//       confirmation before execution". Based on Intuit HITL Principle 1:
//       "Never auto-execute money or destructive ops without a human checkpoint."
//       https://www.kaggle.com/whitepaper-agents §5 (Human-in-the-loop).
//       NOTE: requiresOwnerApproval is PROMPT-ADVISORY ONLY. It instructs the LLM
//       to ask for confirmation — it does NOT stop code execution by itself.
//       Every financial/destructive mutation handler MUST perform an independent
//       server-side confirmation check (e.g. require an explicit "confirmed: true"
//       flag in the tool call or a prior turn's affirmative). Relying solely on
//       this block for safety is insufficient.
//
//   P6  Eval-dataset hook — registration point that associates an agent with its
//       golden-dataset eval file. The eval harness (built separately) reads this
//       registry to discover which dataset to load per agent. Pure metadata —
//       no runtime behaviour.
//
// Design rules (enforced by factory, not by individual agents):
//   - Additive only — existing agents with ZERO new options compile unchanged.
//   - No mutable global state — the eval registry is a Map populated at module
//     load time when agents register themselves; it is only read by the eval
//     harness at test time, never at runtime.
//   - Helpers are pure functions — no I/O, no side effects.

import { userTypedThisAmount } from "@/lib/money/user-typed-amount";

// ── P2  PROHIBICIONES block ───────────────────────────────────────────────────

/**
 * Builds the "PROHIBICIONES (no negociables):" block injected into system
 * prompts by createAdkAgent when `prohibitions` is non-empty.
 *
 * Format (mirrors Google safety system-instruction convention):
 *
 *   PROHIBICIONES (no negociables):
 *   1. <first prohibition>
 *   2. <second prohibition>
 *   …
 *
 * The block is prepended to the agent instruction so it appears BEFORE any
 * role/capability description — making it the first thing the model reads.
 * Sourced from Google system-instruction best-practices 2026:
 *   https://ai.google.dev/gemini-api/docs/system-instructions
 *
 * @param prohibitions - Non-empty array of plain-text prohibition strings.
 *   Each entry must be a complete sentence. The factory adds the numbering.
 */
// NEW-3 decision: NOT merged with create-tool-seams.ts:buildProhibitionsBlock.
// Reason: the two functions serve different injection points with intentionally
// different formats — this one (no leading "\n\n") is prepended to system prompts
// (large token budget, first thing the model reads); the seams version (with
// "\n\n" prefix + char cap) is appended to FunctionDeclaration descriptions
// (tight char budget, comes after the base description). A shared helper with a
// format param would add conditional complexity that outweighs the dedup benefit.
// If the format ever unifies, merge at that point.
export function buildProhibitionsBlock(prohibitions: string[]): string {
  if (prohibitions.length === 0) return "";
  const lines = prohibitions
    .map((p, i) => `${i + 1}. ${p.trim()}`)
    .join("\n");
  return `PROHIBICIONES (no negociables):\n${lines}`;
}

// ── P3  HITL draft→approve seam ──────────────────────────────────────────────

/**
 * Builds the HITL (Human-in-the-Loop) confirmation block injected into system
 * prompts when `requiresOwnerApproval: true` is set on the agent.
 *
 * Pattern: Intuit GenAI Safety Principle 1 — "Never auto-execute money or
 * destructive operations without an explicit human confirmation checkpoint."
 * https://www.kaggle.com/whitepaper-agents §5 (Human-in-the-loop patterns).
 *
 * The block instructs the agent to:
 *   1. Present a DRAFT of the intended mutation.
 *   2. Pause and ask explicitly: "¿Confirmás? (sí/no)".
 *   3. Execute ONLY after receiving an unambiguous affirmative.
 *   4. Never infer confirmation from context or prior turns.
 *
 * The block is appended AFTER the agent's own instruction so the agent's role
 * description remains the primary framing — the HITL constraint is a gating
 * rule layered on top, not a replacement.
 *
 * ⚠ WARNING — PROMPT-ADVISORY ONLY. This block does NOT enforce confirmation
 * at the code level. The mutation handler MUST independently gate execution on
 * an explicit server-side confirmation signal. Do not treat this block as a
 * security boundary.
 */
export function buildHitlBlock(): string {
  return [
    "FLUJO OBLIGATORIO ANTES DE TODA MUTACIÓN (draft→approve):",
    "1. Antes de ejecutar cualquier operación de dinero o destructiva, mostrá un",
    "   BORRADOR claro de lo que vas a hacer (qué, cuánto, quién).",
    "2. Preguntá explícitamente: \"¿Confirmás? (sí / no)\".",
    "3. Ejecutá SOLO si recibís una respuesta afirmativa inequívoca.",
    "4. NUNCA inferás confirmación por contexto, repetición, ni turnos anteriores.",
    "5. Si no hay confirmación clara, cancelá y pedí de nuevo.",
  ].join("\n");
}

// ── P1  DB-first money guard ──────────────────────────────────────────────────

/**
 * Canonical DB-first money amount guard.
 *
 * Rule: the LLM-emitted amount is accepted ONLY when the user literally typed
 * a value matching it in the raw input text (i.e., the user dictated the
 * price — the agent didn't invent it). In all other cases, the DB value is
 * used.
 *
 * Token-match logic delegates to `userTypedThisAmount` in
 * src/lib/money/user-typed-amount.ts — the single source of truth that the
 * H-3 guard (supervisor-action-mapper.money-guard.ts) also uses. This prevents
 * algorithm drift: any change to the token-match logic applies to both guards
 * automatically.
 *
 * Sources:
 *   - Intuit GenAI Safety §4: "Trust your own data systems, not the LLM"
 *     https://www.kaggle.com/whitepaper-agents §3.3
 *   - Wiesinger et al. §3.3: tool results are authoritative over LLM text.
 *
 * @param opts.llmAmount    - Amount emitted by the LLM (may be undefined/null).
 * @param opts.dbAmount     - Canonical amount from the database (authoritative).
 * @param opts.rawUserText  - The unprocessed user message (used to check if the
 *                            user explicitly typed a matching numeric value).
 *                            Pass empty string or null when unavailable — the
 *                            guard falls back to dbAmount (safe default).
 * @param opts.qty          - Sale quantity (if known). When provided, tokens
 *                            equal to qty are excluded from the candidate pool
 *                            so a bare quantity is never read as a stated price.
 *                            Closes the 16x-overcharge regression ("vendé 2500
 *                            alfajores" → llmAmount=2500 → WRONG without qty
 *                            exclusion). Pass undefined when qty is unavailable.
 *
 * IMPORTANT: This helper enforces DB-first provenance only — it does NOT
 * validate whether the amount is "correct" in a business sense. Domain
 * validation belongs in use-cases / policy-engine.
 */
export interface GuardMoneyAmountOptions {
  /** Amount emitted by the LLM (from tool args or structured response). */
  llmAmount: number | null | undefined;
  /** Authoritative amount from the database. */
  dbAmount: number;
  /**
   * The raw user message text as received (before any LLM processing).
   * Used to decide if the user explicitly dictated the amount.
   * Pass empty string or null when unavailable — falls back to dbAmount (safe).
   */
  rawUserText: string | null | undefined;
  /**
   * Sale quantity (if known). Tokens equal to qty are excluded from the
   * candidate pool so a bare quantity is never read as a stated price.
   * Pass undefined when qty is unavailable.
   */
  qty?: number | null | undefined;
}

export interface GuardMoneyAmountResult {
  /** The trusted amount to use for the mutation. */
  amount: number;
  /** true → LLM value was accepted (user explicitly typed it). */
  usedLlm: boolean;
  /** true → DB fallback was used (LLM value was not trusted). */
  usedDb: boolean;
}

export function guardMoneyAmount(opts: GuardMoneyAmountOptions): GuardMoneyAmountResult {
  const { llmAmount, dbAmount, rawUserText, qty } = opts;

  // No LLM value → always use DB.
  if (llmAmount == null || !Number.isFinite(llmAmount) || llmAmount < 0) {
    return { amount: dbAmount, usedLlm: false, usedDb: true };
  }

  // LLM value matches DB exactly → no ambiguity, use DB path (no LLM credit).
  if (llmAmount === dbAmount) {
    return { amount: dbAmount, usedLlm: false, usedDb: true };
  }

  // Check if the user explicitly typed the LLM value in the raw input.
  // qty is passed so qty-tokens are excluded (closes the 16x-overcharge bug).
  const userDictated = userTypedThisAmount(
    rawUserText ?? "",
    llmAmount,
    qty != null ? qty : undefined,
  );
  if (userDictated) {
    return { amount: llmAmount, usedLlm: true, usedDb: false };
  }

  // Default: LLM invented the amount → fall back to DB.
  return { amount: dbAmount, usedLlm: false, usedDb: true };
}

// ── P6  Eval-dataset registration ────────────────────────────────────────────

/**
 * Global eval-dataset registry.
 *
 * Maps agent name (as passed to createAdkAgent) → eval dataset file path.
 * Populated at module-load time when agents register via createAdkAgent with
 * `evalDataset` set. The eval harness (built separately) reads this map to
 * discover which golden dataset to load for each agent.
 *
 * Design: Map (not a plain object) so iteration order is insertion order and
 * entries are iterable without Object.keys gymnastics. Never mutated at
 * runtime — only populated once per process boot.
 *
 * Source: Intuit/Google golden-dataset eval pattern — each agent owns a
 * curated input→expected-output dataset that the harness runs automatically.
 * https://www.kaggle.com/whitepaper-agents §4 (Evaluation).
 */
export const agentEvalRegistry: Map<string, string> = new Map();

/**
 * Registers an agent ↔ eval dataset mapping.
 *
 * Called by createAdkAgent when `evalDataset` is provided. Idempotent: if the
 * same agent name is registered twice (e.g. in hot-reload), the last value
 * wins (Map.set semantics).
 *
 * @param agentName   - The agent's canonical name (must match createAdkAgent `name`).
 * @param datasetPath - Relative path to the golden-dataset JSON file, e.g.
 *                      "tests/eval/ventas-agent.evalset.json".
 *                      Convention: tests/eval/<agent-name>.evalset.json.
 */
export function registerAgentEval(agentName: string, datasetPath: string): void {
  agentEvalRegistry.set(agentName, datasetPath);
}
