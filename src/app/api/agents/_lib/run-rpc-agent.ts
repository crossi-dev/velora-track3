// run-rpc-agent.ts — Shared ADK InMemoryRunner lifecycle for stateless sub-agents.
//
// Extracts the common skeleton repeated across Ventas, Payments, Logística, Fiscal,
// and Communications: create runner → runEphemeral → timeout race → drain loop →
// isFinalResponse guard → finally cleanup.
//
// Per-agent differences stay in the handlers:
//   - Agent construction (createXxxAgent arguments)
//   - Tool-response capture logic (onFunctionResponse callback)
//   - Error classification (Payments/Fiscal keep their own obs; Ventas/Logística/Comms
//     use handleRpcRunnerError from rpc-runner-obs.ts)
//   - Post-drain hooks (empty-drain logging, hallucination guard)
//   - Response shape (extra dataParts, errorCode extraction, etc.)
//
// Reference: google.github.io/adk-docs/runtime/runconfig/ (maxLlmCalls, runEphemeral)
// Pattern mirrors supervisor-agent.ts generator cleanup discipline.

import { InMemoryRunner, isFinalResponse, getFunctionResponses, type Agent } from "@google/adk";

/** A single ADK function-response item as returned by getFunctionResponses(). */
export interface FunctionResponseItem {
  /** Tool name (e.g. "create_payment_link", "emit_invoice"). */
  name: string;
  /** Tool response payload — raw object from the ADK event (null if absent or non-object). */
  response: Record<string, unknown> | null;
}

/**
 * Options for running one stateless A2A RPC turn through InMemoryRunner.
 *
 * @param agent              - Pre-built ADK agent (result of createXxxAgent()).
 * @param appName            - ADK appName (e.g. "velora-ventas-agent").
 * @param userId             - Stable per-agent userId passed to runEphemeral().
 * @param message            - Raw user message text for this turn.
 * @param timeoutMs          - Hard timeout in ms; exceeded → TimeoutError thrown.
 * @param maxLlmCalls        - runConfig.maxLlmCalls cap (default 10).
 * @param onFunctionResponse - Optional callback invoked for each tool-response
 *                            event BEFORE the isFinalResponse check. Use to
 *                            capture structured tool results (payment IDs,
 *                            tracking numbers, Pattern C intents, etc.).
 */
export interface RunRpcAgentOptions {
  agent: Agent;
  appName: string;
  userId: string;
  message: string;
  timeoutMs: number;
  maxLlmCalls?: number;
  onFunctionResponse?: (item: FunctionResponseItem) => void;
  /**
   * When true, exits the drain loop immediately after the first isFinalResponse
   * event. Payments Agent sets this to avoid stalling on trailing ADK events
   * (trace/metadata) that can hold the Vertex stream open for up to ~60s.
   * Default: false (drain to exhaustion, which is correct for all other agents).
   */
  breakOnFirstFinalResponse?: boolean;
}

/**
 * Result of a completed runRpcAgent call.
 *
 * @param replyText - Final text from the last isFinalResponse event (empty string if none).
 * @param error     - The caught error if the runner threw; null on success. The caller is
 *                   responsible for classifying this (via handleRunnerError / handleRpcRunnerError).
 */
export interface RunRpcAgentResult {
  replyText: string;
  error: unknown | null;
}

/**
 * Runs one ephemeral ADK turn through InMemoryRunner.
 *
 * Encapsulates: runner construction, runEphemeral, timeout race, drain loop,
 * isFinalResponse text extraction, getFunctionResponses capture, and finally cleanup.
 *
 * NEVER throws — all errors are captured in result.error so callers can classify
 * them with their own error-obs helpers (handleRpcRunnerError / handleRunnerError).
 */
export async function runRpcAgent(opts: RunRpcAgentOptions): Promise<RunRpcAgentResult> {
  const {
    agent,
    appName,
    userId,
    message,
    timeoutMs,
    maxLlmCalls = 10,
    onFunctionResponse,
    breakOnFirstFinalResponse = false,
  } = opts;

  let replyText = "";
  let caughtError: unknown = null;

  try {
    const runner = new InMemoryRunner({ agent, appName });
    const events = runner.runEphemeral({
      userId,
      newMessage: { role: "user", parts: [{ text: message }] },
      // Cap LLM invocations per turn — infinite-loop protection per Google ADK docs.
      // 10 covers thinking pass + tool call + tool result + final text (4 min) with
      // headroom for retry on tool error. timeoutMs is the real hard backstop.
      // Reference: google.github.io/adk-docs/runtime/runconfig/
      runConfig: { maxLlmCalls },
    });

    // Race the event drain against a hard timeout so a stalled Gemini call
    // does not hold the Cloud Run request until the platform deadline.
    // Generator is explicitly closed in the finally block — stream leak prevention.
    // Same pattern as supervisor-agent.ts.
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(
        () => reject(Object.assign(new Error(`ADK ${appName} timed out`), { name: "TimeoutError" })),
        timeoutMs,
      );
    });

    const drainEvents = async () => {
      for await (const event of events) {
        // Capture function responses before the isFinalResponse check —
        // ADK emits function-response events before the final text event.
        if (onFunctionResponse) {
          const funcResponses = getFunctionResponses(event);
          for (const fr of funcResponses) {
            onFunctionResponse({
              name: fr.name ?? "",
              response: (fr.response && typeof fr.response === "object")
                ? (fr.response as Record<string, unknown>)
                : null,
            });
          }
        }
        if (!isFinalResponse(event)) continue;
        for (const part of event.content?.parts ?? []) {
          if (typeof part.text === "string" && part.text.length > 0) {
            replyText = part.text;
          }
        }
        // Exit on first final-response when requested — trailing ADK events
        // (trace/metadata) can stall the loop until the Vertex stream times out.
        // finally block calls events.return() to release the stream.
        if (breakOnFirstFinalResponse) break;
      }
    };

    try {
      await Promise.race([drainEvents(), timeoutPromise]);
    } finally {
      if (timeoutHandle !== null) clearTimeout(timeoutHandle);
      // Close the async generator to release the underlying Gemini stream.
      // Without this a timeout race leaves the generator open (stream leak).
      try { await events.return(undefined); } catch { /* already exhausted */ }
    }
  } catch (error) {
    caughtError = error;
  }

  return { replyText, error: caughtError };
}
