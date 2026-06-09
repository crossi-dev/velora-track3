import "server-only";
// Factory: createA2AAgentTool
//
// Shared skeleton for all Supervisor -> sub-agent A2A FunctionTool wrappers.
// Eliminates ~60 lines of identical boilerplate duplicated across the 7
// call-*-agent-tool.ts files (deriveA2AKey, cloudLog INFO, sendMessage with
// deadline-propagation timeout, catch with 429 detection, cloudLog ERROR).
//
// Pattern mirrors agent-rpc-factory.ts (same optional-callback technique).
// Source: Wiesinger et al. SS3.2 -- tool description functions as LLM documentation.
// https://www.kaggle.com/whitepaper-agents
// ADK FunctionTool docs: https://google.github.io/adk-docs/tools/function-tools/
//
// GAP2 fix (2026-06-02): default buildFullMessage now uses createBriefMessage
// (see create-brief-message.ts) instead of raw prose. Every A2A dispatch gets
// OBJECTIVE / CONSTRAINTS / OUTPUT FORMAT / ON FAILURE sections.
// Source: Google ADK multi-agent best practices
// https://google.github.io/adk-docs/multi-agents/

import { FunctionTool } from "@google/adk";
import type { Schema } from "@google/genai";
import { sendMessage, A2AClientError } from "@/lib/a2a-client";
import { signAgentAssertion, type AgentId } from "@/lib/agent-identity";
import { cloudLog } from "@/lib/cloud-logger";
import { deriveA2AKey } from "@/app/api/a2a/jsonrpc/_lib/handle-rpc";
import { remainingBudget } from "@/lib/agent-timeouts";
import { createBriefMessage } from "./create-brief-message";

// Re-export so callers only need to import from this module.
export { createBriefMessage } from "./create-brief-message";
export type { BriefMessageOptions } from "./create-brief-message";
// -- Public types ---------------------------------------------------------------

/** Pattern C intent from a sub-agent dataPart — mirrors CapturedAgentIntent in agent-call-actions.ts. */
export interface PatternCIntent { intent: string; data: unknown; summary: string; }

/** Minimal runtime context every A2A tool needs. */
export interface A2AAgentToolContext {
  businessId: string;
  appUrl: string;
  apiKey: string | undefined;
  /**
   * Date.now() captured at request entry. When provided, timeoutMs is derived
   * from remainingBudget() (Deadline Propagation) instead of the fixed constant.
   * https://sre.google/sre-book/addressing-cascading-failures/
   */
  requestStartedAt?: number;
  /**
   * Shared accumulator for Pattern C intents from dataParts (ADK path fix 2026-06-03).
   * When present, the tool pushes { intent, data, summary } from each successful
   * reply into this array. injectPatternCAccumulator (supervisor-agent.tools.ts)
   * wires the same array into all A2A tool contexts before the ADK run starts.
   * Non-Pattern-C agents (payments, caja, logistica, fiscal) emit no dataParts —
   * passing this to them is safe; they simply never push.
   */
  capturedPatternCIntents?: PatternCIntent[];
}

/** Return shape shared by all call-*-agent-tool execute functions. */
export interface A2AAgentToolResult {
  text: string | null;
  success: boolean;
  error?: string;
  /** Set by Logistica/Contador guards when required business data is absent. */
  missingData?: boolean;
}

/**
 * Config object passed to createA2AAgentTool.
 *
 * @param C - Tool-specific context type (must extend A2AAgentToolContext).
 * @param A - Tool args type (parsed from execute).
 */
export interface CreateA2AAgentToolOptions<
  C extends A2AAgentToolContext,
  A extends { message: string },
> {
  /** FunctionTool name -- must match the string used in tool descriptions. */
  toolName: string;
  /** LLM-visible description (Wiesinger SS3.2 -- precision matters). */
  description: string;
  /** Genai Schema object for the tool parameters. */
  schema: Schema;
  /** Timeout constant (ms) for this agent. Used as fallback when requestStartedAt is absent. */
  timeoutMs: number;
  /**
   * Caller identity for signAgentAssertion -- the "from" side of the A2A JWT.
   * Always "supervisor" for tools wired into the Supervisor.
   */
  callerIdentity: AgentId;
  /**
   * Target identity for signAgentAssertion -- the "to" side of the A2A JWT.
   * E.g. "ventas", "equipo", "payments", "fiscal", "logistica", "communications", "customer".
   */
  targetIdentity: AgentId;
  /** Agent JSON-RPC path, e.g. "/api/agents/ventas/jsonrpc". */
  agentPath: string;
  /**
   * Log action key -- used for both INFO and FAILED log entries.
   * E.g. "VENTAS" -> actions "ADK_A2A_VENTAS_CALL" and "ADK_A2A_VENTAS_FAILED".
   */
  logActionKey: string;
  /**
   * Human-readable agent display name for error messages.
   * E.g. "Ventas Agent", "Pagos Agent".
   */
  agentDisplayName: string;
  /**
   * Whether this tool has 429 (rate-limit) handling with a specific user message.
   * When true, the catch block checks err.code === 429 and uses rateLimitMessage
   * as the user-facing error; severity is WARNING instead of ERROR.
   */
  has429Handling?: boolean;
  /** User-facing message when the downstream agent returns 429. Required when has429Handling=true. */
  rateLimitMessage?: string;
  /**
   * When true, A2AClientError messages include the error code.
   * Default false produces the shorter form without the code suffix.
   * Set true for: equipo, logistica, contador.
   */
  includeCodeInA2AError?: boolean;
  /**
   * When false, the FAILED cloudLog data object omits businessId.
   * Default true. Set false for: logistica, contador (original logs had no businessId).
   */
  includeBusinessIdInFailLog?: boolean;
  /**
   * Optional pre-condition guard -- runs BEFORE the A2A sendMessage call.
   * Used by Logistica (postalCode check) and Contador (CUIT check).
   * Return a result object to short-circuit (guard blocked); return null to proceed.
   */
  preConditionGuard?: (args: A, ctx: C) => Promise<A2AAgentToolResult | null>;
  /**
   * Optional full-message builder -- called to construct the text payload sent to the agent.
   * Default: createBriefMessage({ businessId, objective: args.message }) -- structured envelope.
   * Override for tools that embed extra headers (customer) or enriched suffixes (contador).
   * Callers that override SHOULD call createBriefMessage internally to preserve the envelope.
   */
  buildFullMessage?: (args: A, ctx: C) => Promise<string> | string;
  /**
   * Optional post-success hook -- runs AFTER a successful sendMessage reply.
   * Used by Payments (WhatsApp side-effect).
   * Receives the reply text and full args; its return value is ignored.
   */
  postSuccessHook?: (replyText: string, args: A, ctx: C) => Promise<void>;
}

// -- Factory ------------------------------------------------------------------
/**
 * Creates a FunctionTool wrapping the standard Velora A2A call skeleton.
 * Each tool only needs to supply its config object; the shared boilerplate
 * (key derivation, cloudLog INFO, sendMessage with deadline propagation,
 * catch with 429 detection, cloudLog ERROR/WARNING) is handled here.
 *
 * Default buildFullMessage uses createBriefMessage (GAP2 fix) -- structured
 * brief envelope replaces raw LLM prose. Tools with custom builders (payments,
 * contador, customer) also call createBriefMessage internally.
 */
export function createA2AAgentTool<
  C extends A2AAgentToolContext,
  A extends { message: string },
>(opts: CreateA2AAgentToolOptions<C, A>, ctx: C): FunctionTool {
  const {
    toolName,
    description,
    schema,
    timeoutMs,
    callerIdentity,
    targetIdentity,
    agentPath,
    logActionKey,
    agentDisplayName,
    has429Handling = false,
    rateLimitMessage,
    includeCodeInA2AError = false,
    includeBusinessIdInFailLog = true,
    preConditionGuard,
    buildFullMessage,
    postSuccessHook,
  } = opts;

  return new FunctionTool({
    name: toolName,
    description,
    parameters: schema,
    execute: async (rawArgs: unknown) => {
      // NEW-2: rawArgs must be a non-null object with a non-empty string message.
      const _msg = rawArgs != null && typeof rawArgs === "object" ? (rawArgs as Record<string, unknown>).message : undefined;
      if (typeof _msg !== "string" || _msg.trim() === "") {
        const errMsg = `${agentDisplayName}: invalid input — args must be an object with a non-empty message string.`;
        cloudLog({ severity: "WARNING", component: "Supervisor", action: `ADK_A2A_${logActionKey}_INVALID_INPUT`,
          a2a_transfer: false, message: errMsg, data: { rawArgsType: rawArgs === null ? "null" : typeof rawArgs } });
        return { text: null, success: false, error: errMsg };
      }
      const args = rawArgs as A;

      // Pre-condition guard (e.g. postalCode / CUIT check)
      if (preConditionGuard) {
        const guardResult = await preConditionGuard(args, ctx);
        if (guardResult !== null) return guardResult;
      }

      const agentUrl = `${ctx.appUrl}${agentPath}`;
      // Default: structured brief envelope (GAP2 fix -- replaces raw LLM prose).
      const fullMessage = buildFullMessage
        ? await buildFullMessage(args, ctx)
        : createBriefMessage({ businessId: ctx.businessId, objective: args.message });

      const a2aSecret = process.env.A2A_SECRET ?? "";
      const derivedKey = a2aSecret ? deriveA2AKey(a2aSecret, ctx.businessId) : undefined;

      cloudLog({
        severity: "INFO",
        component: "Supervisor",
        action: `ADK_A2A_${logActionKey}_CALL`,
        a2a_transfer: true,
        message: `ADK in-band A2A call -> ${agentUrl}`,
        data: { businessId: ctx.businessId },
      });

      try {
        const reply = await sendMessage(agentUrl, fullMessage, {
          apiKey: derivedKey,
          // Factory -- fresh JWT per attempt to prevent JTI replay on retries.
          agentAssertionFactory: () => signAgentAssertion(callerIdentity, targetIdentity),
          // Deadline Propagation: use remaining outer-gate budget when the request
          // start time is available; fall back to the fixed constant otherwise.
          // Source: https://sre.google/sre-book/addressing-cascading-failures/
          timeoutMs:
            ctx.requestStartedAt != null
              ? Math.max(remainingBudget(ctx.requestStartedAt), timeoutMs / 10)
              : timeoutMs,
        });

        const text = reply.text ?? "";

        if (postSuccessHook) {
          await postSuccessHook(text, args, ctx);
        }

        // ADK path fix (2026-06-03): push Pattern C intents from dataParts into
        // ctx.capturedPatternCIntents so executeSupActions can inject them into
        // supResult.actions before resolveCompoundActions runs.
        // Source: A2A Protocol v1.0 §3 https://a2a-protocol.org/latest/specification/
        if (ctx.capturedPatternCIntents) {
          for (const part of reply.dataParts ?? []) {
            if (!part || typeof part !== "object") continue;
            const obj = part as { intents?: unknown };
            if (!Array.isArray(obj.intents)) continue;
            for (const raw of obj.intents) {
              if (!raw || typeof raw !== "object") continue;
              const cand = raw as { intent?: unknown; data?: unknown; summary?: unknown };
              if (
                typeof cand.intent === "string" &&
                cand.data !== undefined &&
                typeof cand.summary === "string"
              ) {
                ctx.capturedPatternCIntents.push({
                  intent: cand.intent,
                  data: cand.data,
                  summary: cand.summary,
                });
              }
            }
          }
        }

        return { text, success: true };
      } catch (err) {
        const is429 = has429Handling && err instanceof A2AClientError && err.code === 429;
        const a2aErrMsg =
          err instanceof A2AClientError
            ? includeCodeInA2AError
              ? `${agentDisplayName} error (code ${err.code ?? "?"}): ${err.message}`
              : `${agentDisplayName} error: ${err.message}`
            : err instanceof Error
            ? `${agentDisplayName} error: ${err.message}`
            : `${agentDisplayName} no disponible.`;
        const errMsg = is429
          ? (rateLimitMessage ?? `${agentDisplayName} rate-limited.`)
          : a2aErrMsg;

        cloudLog({
          severity: is429 ? "WARNING" : "ERROR",
          component: "Supervisor",
          action: `ADK_A2A_${logActionKey}_FAILED`,
          a2a_transfer: false,
          message: errMsg,
          data: {
            agentUrl,
            ...(includeBusinessIdInFailLog && { businessId: ctx.businessId }),
            ...(has429Handling && { code: err instanceof A2AClientError ? err.code : undefined }),
          },
        });

        return { text: null, success: false, error: errMsg };
      }
    },
  });
}
