// agent-factory.ts — Reusable ADK Agent constructor.
//
// Every Velora sub-agent (Fiscal, Payments, Equipo, Logística, Ventas, and
// future ones like Comunicaciones) follows the same shape:
//   - stateless per-request Agent (no shared mutable state)
//   - LLM model via BaseLlm (GeminiAdapter today; engine-agnostic seam via S1)
//   - instruction passed as a callback to bypass ADK template resolution
//     (avoids "Context variable not found" on braces in system prompts)
//   - optional generateContentConfig for token caps
//
// Usage:
//   const agent = createAdkAgent({
//     name: "velora_comunicaciones_agent",
//     model: getAdkComunicacionesModel(),
//     instruction: COMUNICACIONES_SYSTEM_PROMPT,
//     tools: [myTool],
//   });
//
// ─── Cross-cutting seams (audit 2026-06-03) — optional, additive ─────────────
// prohibitions?: string[]  → P2 PROHIBICIONES block prepended to instruction.
// requiresOwnerApproval?: boolean → P3 HITL draft→approve block appended.
// evalDataset?: string     → P6 registers agent in agentEvalRegistry (metadata).
// guardMoneyAmount()       → P1 DB-first money guard — standalone helper, NOT
//   wired into callbacks (per-mutation concern; see agent-factory.seams.ts).
// Existing call sites with ZERO new fields compile unchanged.
//
// ─── Encoded lessons (hard-won, apply to ALL agents) ─────────────────────────
//
// (a) Function-calling mode AUTO is the default and correct choice for
//     conversational agents. Do NOT set mode=ANY. ANY forces every prompt to
//     produce a tool call — if the LLM has satisfied the user's intent and
//     wants to emit a plain text reply, ANY blocks it and the agent loops back
//     with an empty or malformed response. Use context injection instead of
//     mode=ANY to guide tool selection.
//     Source (verified HTTP 200): https://ai.google.dev/gemini-api/docs/function-calling
//
// (b) Event.author in replayed history MUST be the agent's own name — not
//     the string "model". ADK matches events to agents by name; "model" is not
//     a recognised agent identifier and breaks multi-turn memory reconstruction
//     in sessions that use ChatMessageSessionService (Postgres-backed).
//     Source: @google/adk LlmAgentConfig (llm_agent.d.ts),
//     observed in Velora session-continuity debugging (2026-05).
//
// (c) Tool errors must be logged, never swallowed silently. The factory wires
//     afterToolCallback on every agent so that any tool throw is surfaced as a
//     WARNING in Cloud Logging. Prior to this, tool failures were invisible —
//     the agent received an error object back from the framework but neither
//     the factory nor the tools emitted structured logs, making prod debugging
//     a blind spot.
//     Source: https://adk.dev/callbacks/ (verified HTTP 200 2026-05-29)
//
// ─────────────────────────────────────────────────────────────────────────────

import { Agent } from "@google/adk";
import type { BaseTool, SingleBeforeToolCallback, SingleAfterToolCallback } from "@google/adk";
import type { BaseLlm } from "@google/adk";
import { cloudLog } from "@/lib/cloud-logger";
import {
  buildProhibitionsBlock,
  buildHitlBlock,
  registerAgentEval,
} from "./agent-factory.seams";

// Re-export public seam helpers so callers can import everything from
// agent-factory without a separate seams import.
export {
  buildProhibitionsBlock,
  buildHitlBlock,
  guardMoneyAmount,
  agentEvalRegistry,
  registerAgentEval,
} from "./agent-factory.seams";
export type {
  GuardMoneyAmountOptions,
  GuardMoneyAmountResult,
} from "./agent-factory.seams";

// ── Safe arg summariser ───────────────────────────────────────────────────────
//
// Produces a shape-only summary of tool args — keys and value types, NOT
// values. Guarantees NO PII (phone numbers, names, emails, addresses, amounts)
// reaches Cloud Logging from the factory layer. Individual tools may log
// sanitised values themselves at their own discretion.
//
// Example: { phone: "+549...", qty: 3 } → { phone: "string", qty: "number" }

function summariseArgs(args: Record<string, unknown>): Record<string, string> {
  const summary: Record<string, string> = {};
  for (const key of Object.keys(args)) {
    const val = args[key];
    if (val === null) {
      summary[key] = "null";
    } else if (Array.isArray(val)) {
      summary[key] = `array(${(val as unknown[]).length})`;
    } else {
      summary[key] = typeof val;
    }
  }
  return summary;
}

// ── Per-tool observability callbacks ─────────────────────────────────────────
//
// Callback signatures verified against installed @google/adk types (llm_agent.d.ts):
//
//   SingleBeforeToolCallback:
//     (params: { tool: BaseTool; args: Record<string, unknown>; context: Context })
//       => Record<string, unknown> | undefined | Promise<...>
//
//   SingleAfterToolCallback:
//     (params: { tool: BaseTool; args: Record<string, unknown>;
//                context: Context; response: Record<string, unknown> })
//       => Record<string, unknown> | undefined | Promise<...>
//
// ADK contract: returning undefined is the pass-through signal — the framework
// continues with the original tool result. These callbacks NEVER return a value
// so they cannot alter the tool result or skip tool execution.
// Source: https://adk.dev/callbacks/ (verified HTTP 200 2026-05-29)

const beforeToolObserver: SingleBeforeToolCallback = ({ tool, args }) => {
  cloudLog({
    severity: "DEBUG",
    component: "System",
    action: "TOOL_CALL_START",
    a2a_transfer: false,
    message: `ADK tool call start: ${tool.name}`,
    data: {
      tool: tool.name,
      argShape: summariseArgs(args),
    },
  });
  // Pass-through: returning undefined lets the framework call the actual tool.
  return undefined;
};

const afterToolObserver: SingleAfterToolCallback = ({ tool, args, response }) => {
  // Detect error responses. ADK wraps tool throws in a response object; the
  // most reliable signal is a non-null "error" key at the root of the response
  // map. Checking presence alone ("error" in response) would false-positive on
  // RPC-style responses that include a null-sentinel error field
  // (e.g. { result: "ok", error: null }).
  const hasError =
    typeof response === "object" &&
    response !== null &&
    "error" in response &&
    response["error"] != null;

  cloudLog({
    severity: hasError ? "WARNING" : "DEBUG",
    component: "System",
    action: hasError ? "TOOL_CALL_ERROR" : "TOOL_CALL_END",
    a2a_transfer: false,
    message: hasError
      ? `ADK tool error: ${tool.name}`
      : `ADK tool call end: ${tool.name}`,
    data: {
      tool: tool.name,
      argShape: summariseArgs(args),
      responseKeys: Object.keys(response ?? {}),
      ...(hasError
        ? { error: String((response as Record<string, unknown>).error) }
        : {}),
    },
  });
  // Pass-through: returning undefined preserves the original tool response.
  return undefined;
};

// ─────────────────────────────────────────────────────────────────────────────

export interface CreateAdkAgentOptions {
  /** ADK agent name — must be unique per InMemoryRunner instance. */
  name: string;
  /**
   * Resolved LLM model instance (from gemini-config.ts helpers).
   * Typed as BaseLlm (the public ADK abstraction) so any VeloraEngineAdapter
   * or Gemini instance satisfies this field — widened from `Gemini` in S1.
   * Call sites pass getAdkXxxModel() which returns GeminiAdapter (extends BaseLlm).
   */
  model: BaseLlm;
  /**
   * System instruction — string or () => string.
   * ALWAYS passed as a callback internally to bypass ADK's {identifier}
   * template resolution, which crashes when the prompt contains JSON braces.
   */
  instruction: string | (() => string);
  /**
   * Optional agent description — used by AgentTool as the tool's description
   * when this agent is wrapped and exposed to a parent agent's tools array.
   */
  description?: string;
  /** FunctionTools to register. Pass [] for a zero-tool agent. */
  tools?: BaseTool[];
  /**
   * Optional token/thinking caps forwarded to generateContentConfig.
   *
   * Typed as `Record<string, unknown>` because ADK ships its own nested copy
   * of @google/genai with a nominally distinct GenerateContentConfig type.
   * Importing from the outer @google/genai causes TS2345 (dual-genai issue).
   * Same workaround used by supervisor-agent.ts (inline object literals pass
   * without the import; only typed references trigger the error).
   *
   * Values: { maxOutputTokens, thinkingConfig: { thinkingLevel | thinkingBudget }, temperature }
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ADK dual-genai nested copy; nominal type mismatch at SDK boundary only.
  generateContentConfig?: Record<string, any>;
  /**
   * Override factory-level tool observability callbacks.
   *
   * The factory wires beforeToolCallback + afterToolCallback on every agent by
   * default (pure observability, no behaviour change). Override only if a
   * specific agent needs to suppress or augment logging.
   */
  beforeToolCallback?: SingleBeforeToolCallback;
  afterToolCallback?: SingleAfterToolCallback;

  // ── Cross-cutting concern seams (all optional — existing call sites unchanged)

  /**
   * P2 — Injects "PROHIBICIONES (no negociables):" numbered block BEFORE the
   * agent instruction. Each entry is a complete prohibition sentence; the
   * factory adds the numbering. Full docs in agent-factory.seams.ts.
   * Source: https://ai.google.dev/gemini-api/docs/system-instructions
   */
  prohibitions?: string[];

  /**
   * P3 — Appends a HITL draft→approve block: DRAFT → "¿Confirmás?" → execute
   * only on affirmative. Use for money/destructive ops.
   * Source: https://www.kaggle.com/whitepaper-agents §5. PROMPT-ADVISORY ONLY —
   * mutation handlers MUST enforce server-side confirmation independently.
   */
  requiresOwnerApproval?: boolean;

  /**
   * P6 — Relative path to the golden-dataset JSON file for this agent
   * (e.g. "tests/eval/ventas-agent.evalset.json"). Registers the agent in
   * agentEvalRegistry at construction time. Zero runtime behaviour — the eval
   * harness reads the registry at test time. Full docs in agent-factory.seams.ts.
   * Source: https://www.kaggle.com/whitepaper-agents §4
   */
  evalDataset?: string;
}

/**
 * Creates a stateless per-request ADK Agent with Velora's canonical defaults.
 *
 * Wraps instruction in a callback unconditionally — the single most common
 * source of ADK "Context variable not found" errors in Velora's codebase.
 *
 * Wires per-tool observability callbacks on every agent so that tool calls
 * and tool errors are always visible in Cloud Logging. These are pure
 * pass-through observers — they never alter tool results or agent flow.
 */
export function createAdkAgent(opts: CreateAdkAgentOptions): Agent {
  const {
    name,
    description,
    model,
    instruction,
    tools = [],
    generateContentConfig,
    beforeToolCallback = beforeToolObserver,
    afterToolCallback = afterToolObserver,
    prohibitions,
    requiresOwnerApproval,
    evalDataset,
  } = opts;

  // P6 — register eval dataset before Agent construction (metadata only).
  if (evalDataset) registerAgentEval(name, evalDataset);

  // P2 + P3 — compose instruction: PROHIBICIONES → base → HITL.
  // Order is intentional: hard constraints appear before role framing (P2) and
  // the confirmation gate is appended after (P3) so the agent role stays primary.
  // Instruction always wrapped as a callback to bypass ADK {identifier} resolution.
  const baseInstructionFn =
    typeof instruction === "function" ? instruction : () => instruction;
  const prohibitionsBlock =
    prohibitions && prohibitions.length > 0 ? buildProhibitionsBlock(prohibitions) : "";
  const hitlBlock = requiresOwnerApproval ? buildHitlBlock() : "";
  // No seams active → zero overhead; functionally identical to the original factory.
  const instructionFn = prohibitionsBlock || hitlBlock
    ? () => {
        const parts = [prohibitionsBlock, baseInstructionFn(), hitlBlock].filter(Boolean);
        return parts.join("\n\n");
      }
    : baseInstructionFn;

  return new Agent({
    name,
    ...(description !== undefined ? { description } : {}),
    model,
    instruction: instructionFn,
    ...(tools.length > 0 ? { tools } : {}),
    ...(generateContentConfig ? { generateContentConfig } : {}),
    beforeToolCallback,
    afterToolCallback,
  });
}
