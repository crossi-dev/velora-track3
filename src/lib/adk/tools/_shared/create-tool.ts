import "server-only";
// create-tool.ts — Thin tool constructor (the createAdkAgent equivalent for FunctionTools).
//
// Every domain tool in Velora is built through this factory so that cross-cutting
// concerns are applied once and never re-implemented per-tool:
//
//   (a) Zod input validation — rejects malformed LLM payloads before business logic runs.
//   (b) Namespacing — tool names follow "domain.tool_name" convention.
//   (c) Standard error envelope — { code, message } matching api-standards.ts.
//   (d) Observability — before/after callbacks compatible with agent-factory.ts observers.
//   (e) Idempotency hook — opt-in seam for mutating tools (beginIdempotentMutation).
//       Two modes (backward compatible):
//       - Legacy (deprecated): caller passes idempotency.key set from an LLM arg — still works.
//       - Server-derived (preferred): caller passes turnIdempotency + the factory derives the
//         key from SHA-256(turnId | toolName | canonicalInput) — LLM cannot influence the key.
//   (f) Backend-seam binding — backend typed as a port, never a concrete adapter.
//   (g) Prohibitions injection — opt-in PROHIBICIONES block appended to description.
//
// New seams (feat/factory-trust-upgrade — implementation in create-tool-seams.ts):
//   deriveServerKey   — SHA-256 key derivation for server-side idempotency.
//   buildProhibitionsBlock — builds the "PROHIBICIONES" description suffix.
//
// Design mirrors agent-factory.ts (createAdkAgent) and create-a2a-agent-tool.ts.
//
// Sources:
//   ADK FunctionTool: https://google.github.io/adk-docs/tools/function-tools/
//   Zod: https://zod.dev (v3 API, ^3.25 in package.json)

import { FunctionTool } from "@google/adk";
import type { Schema } from "@google/genai";
import { z } from "zod";
import { cloudLog } from "@/lib/cloud-logger";
import { deriveServerKey, buildProhibitionsBlock } from "./create-tool-seams";

// Re-export so callers can import deriveServerKey from the same entry point.
export { deriveServerKey } from "./create-tool-seams";

// ── Branded turn ID ────────────────────────────────────────────────────────────
//
// M1: ServerTurnId is a branded string so that a plain LLM-sourced string is
// structurally non-assignable to the turnId field. Callers MUST wrap a
// server-generated value (e.g. randomUUID()) with serverTurnId() before passing
// it to turnIdempotency. This makes "accidentally passing an LLM string" a
// compile-time error rather than a silent replay-attack vector.
//
// Runtime behaviour is identical — the brand is erased at runtime (it is a
// TypeScript-only fiction). No performance cost.

/** Opaque brand for server-generated turn IDs. Use serverTurnId() to construct. */
export type ServerTurnId = string & { readonly __brand: unique symbol };

/**
 * Wraps a server-generated UUID string as a ServerTurnId.
 * Always call this with a value from crypto.randomUUID() or equivalent —
 * never pass LLM-emitted strings here.
 *
 * @example
 *   import { randomUUID } from "crypto";
 *   const turnId = serverTurnId(randomUUID());
 */
export function serverTurnId(raw: string): ServerTurnId {
  return raw as ServerTurnId;
}

// ── Error envelope ─────────────────────────────────────────────────────────────

export interface ToolError {
  code: string;
  message: string;
}

export type ToolResult<T extends Record<string, unknown> = Record<string, unknown>> =
  | ({ error?: undefined } & T)
  | { error: ToolError };

// ── Idempotency hook ───────────────────────────────────────────────────────────
//
// Two modes (both produce a populated IdempotencyHook.key for execute()):
//
//   Server-derived (PREFERRED — use turnIdempotency on CreateToolOptions):
//     The factory derives key = SHA-256(turnId | toolName | canonical(input))
//     AFTER Zod validation. The LLM never supplies nor touches the key.
//     Cross-intent replay attacks are structurally impossible.
//
//   Legacy caller-supplied (DEPRECATED — pass idempotency on CreateToolOptions):
//     The caller sets key before creating the tool. If key originated from an
//     LLM arg, replay-attack risk remains. Still supported for backward compat;
//     existing tools keep compiling. Migrate to turnIdempotency when safe.

export interface IdempotencyHook {
  /**
   * Resolved idempotency key.
   * Server-derived path: SHA-256(turnId | toolName | canonical(input)).slice(0,32).
   * Legacy path: whatever the caller supplied (may be LLM-sourced — deprecated).
   */
  key: string;
  /** businessId for the mutation contract. */
  businessId: string;
  /** actionType key from mutation-contract-entries.ts. */
  actionType: string;
}

// ── Factory options ────────────────────────────────────────────────────────────

export interface CreateToolOptions<TInput extends z.ZodTypeAny, TBackend> {
  /** Namespaced tool name — "domain.tool_name". Validated at construction time. */
  name: string;
  /** LLM-visible description. Precision matters — see Wiesinger §3.2. */
  description: string;
  /** Genai Schema for the FunctionTool parameters block (drives LLM calling convention). */
  schema: Schema;
  /** Zod schema for runtime input validation (provides TypeScript types + runtime guard). */
  inputSchema: TInput;
  /** Backend port instance — never a concrete adapter. */
  backend: TBackend;

  /**
   * [PREFERRED] Server-derived idempotency for mutating tools.
   * The factory derives the key AFTER Zod validation as:
   *   deriveServerKey(turnId, name, validatedInput)
   * LLM cannot influence the key — cross-intent replay is structurally impossible.
   * Migration path: replace `idempotency` with this + remove idempotency_key from schemas.
   */
  turnIdempotency?: {
    /**
     * Per-request UUID generated server-side (randomUUID() in the route handler).
     * Must be a ServerTurnId — use serverTurnId(randomUUID()) to construct.
     * Typed as ServerTurnId so LLM-sourced plain strings are rejected at compile time.
     */
    turnId: ServerTurnId;
    businessId: string;
    actionType: string;
  };

  /**
   * [DEPRECATED] Caller-supplied idempotency hook (backward compat — still compiles).
   * Risk: if key originates from an LLM arg, silent wrong replay is possible.
   * Prefer turnIdempotency for new tools.
   */
  idempotency?: IdempotencyHook;

  /**
   * When true, errors thrown in execute() propagate (hard stop) instead of becoming
   * a soft { error } envelope. Use for money/legal paths (fiscal CAE, payment capture).
   * Default false. See jd/fiscal-tools C-1.
   */
  rethrowErrors?: boolean;

  /**
   * Hard constraints injected into the LLM-visible description.
   * The factory appends a "PROHIBICIONES (no negociables):" numbered block.
   * Default: nothing appended (backward compatible).
   *
   * Example:
   *   prohibitions: ["Nunca inventes precios — usá SOLO valores de la DB."]
   */
  prohibitions?: string[];

  execute: (params: {
    input: z.infer<TInput>;
    backend: TBackend;
    idempotency: IdempotencyHook | undefined;
  }) => Promise<ToolResult>;
}

// ── Name validator ─────────────────────────────────────────────────────────────

const NAMESPACED_TOOL_NAME = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;

function assertNamespacedName(name: string): void {
  if (!NAMESPACED_TOOL_NAME.test(name)) {
    throw new Error(
      `createTool: name "${name}" must follow "domain.tool_name" convention ` +
        `(e.g. "caja.abrir_caja"). Got: "${name}".`,
    );
  }
}

// ── Factory ────────────────────────────────────────────────────────────────────

/**
 * Creates a FunctionTool with Velora's canonical cross-cutting concerns.
 * See file header for the full list of concerns (a)–(g).
 */
export function createTool<TInput extends z.ZodTypeAny, TBackend>(
  opts: CreateToolOptions<TInput, TBackend>,
): FunctionTool {
  const {
    name, description, schema, inputSchema, backend,
    idempotency, turnIdempotency, execute, rethrowErrors, prohibitions,
  } = opts;

  assertNamespacedName(name);

  // (g) Prohibitions — append to description when provided.
  const resolvedDescription =
    prohibitions && prohibitions.length > 0
      ? description + buildProhibitionsBlock(prohibitions)
      : description;

  return new FunctionTool({
    name,
    description: resolvedDescription,
    parameters: schema,
    execute: async (rawArgs: unknown) => {
      // (d) Before.
      cloudLog({
        severity: "DEBUG",
        component: "System",
        action: "TOOL_CALL_START",
        a2a_transfer: false,
        message: `createTool: ${name}`,
        data: { tool: name, argKeys: Object.keys((rawArgs as Record<string, unknown>) ?? {}) },
      });

      // (a) Zod validation.
      const parsed = inputSchema.safeParse(rawArgs);
      if (!parsed.success) {
        const message = parsed.error.issues.map((i) => i.message).join("; ");
        cloudLog({
          severity: "WARNING",
          component: "System",
          action: "TOOL_CALL_INVALID_INPUT",
          a2a_transfer: false,
          message: `createTool validation failed: ${name}`,
          data: { tool: name, validationError: message },
        });
        return { error: { code: "INVALID_INPUT", message } } satisfies ToolResult;
      }

      // (e) Idempotency resolution.
      // Server-derived (turnIdempotency) takes priority — key is computed here,
      // after validation, so input is guaranteed clean and canonical before hashing.
      // Legacy (idempotency) forwarded as-is for backward compat.
      let resolvedIdempotency: IdempotencyHook | undefined;
      if (turnIdempotency) {
        resolvedIdempotency = {
          key: deriveServerKey(turnIdempotency.turnId, name, parsed.data),
          businessId: turnIdempotency.businessId,
          actionType: turnIdempotency.actionType,
        };
      } else {
        resolvedIdempotency = idempotency;
      }

      let result: ToolResult;
      try {
        result = await execute({ input: parsed.data, backend, idempotency: resolvedIdempotency });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unexpected tool error.";
        // (c) Hard-fail seam — rethrow for money/legal paths (jd/fiscal-tools C-1).
        if (rethrowErrors) {
          cloudLog({
            severity: "ERROR",
            component: "System",
            action: "TOOL_CALL_THROW",
            a2a_transfer: false,
            message: `createTool hard-fail (rethrow): ${name}`,
            data: { tool: name, error: message },
          });
          throw err;
        }
        result = { error: { code: "TOOL_ERROR", message } };
      }

      // (d) After.
      const hasError =
        typeof result === "object" && result !== null &&
        "error" in result && result.error != null;
      cloudLog({
        severity: hasError ? "WARNING" : "DEBUG",
        component: "System",
        action: hasError ? "TOOL_CALL_ERROR" : "TOOL_CALL_END",
        a2a_transfer: false,
        message: hasError ? `createTool error: ${name}` : `createTool end: ${name}`,
        data: { tool: name, ...(hasError && { error: String((result as { error: ToolError }).error?.code) }) },
      });

      return result;
    },
  });
}
