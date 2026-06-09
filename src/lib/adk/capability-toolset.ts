// capability-toolset.ts — ADK BaseToolset implementation for capability-aware tool routing.
//
// Implements the ADK BaseToolset contract so that tools exposed to the Supervisor LLM
// are filtered at request time based on app:* capability flags injected into session.state.
//
// How it works:
//   1. supervisor-runner.capabilities.ts loads BusinessCapabilities from DB.
//   2. supervisor-agent.ts injects them as stateDelta to runEphemeral().
//   3. ADK merges stateDelta into session.state via EventActions on the first user message.
//   4. CapabilityToolset.getTools(context) reads ReadonlyContext.state.get("app:*") and
//      returns only the tools whose provider capability is satisfied.
//
// Provider gating:
//   call_payments_agent   — requires mercadopago OR alias_cbu
//   call_logistica_agent  — requires andreani
//   call_contador_agent   — requires arca
//   call_customer_agent   — requires whatsapp_business_connected OR whatsapp_phone_set
//   call_ventas_agent     — always included (no provider dependency)
//   call_communications_agent — always included
//   data tools (check_stock, business_query) — always included when registered
//
// ADK source citations:
//   BaseToolset + getTools(context): https://adk.dev/tools-custom/
//     Verified: convertToolUnionToTools() in llm_agent.js calls toolUnion.getTools(context)
//     for non-BaseTool union elements (BaseToolset subclasses).
//   ReadonlyContext.state: https://adk.dev/sessions/state/
//     Verified: ReadonlyContext.state returns State(session.state, {});
//     State.get(key) checks delta first (from stateDelta) then value.
//   Tool limitations (custom FunctionTools unrestricted): https://adk.dev/tools/limitations/
//
// JD Round 2 BLOCK #2 — fail-closed vs fail-open semantics documented here and in getTools().
// See docs/REFACTOR_STEP1_5B_ROUND2.md for full analysis.

import { BaseToolset } from "@google/adk";
import type { BaseTool, ReadonlyContext } from "@google/adk";
import { cloudLog } from "@/lib/cloud-logger";

// ---------------------------------------------------------------------------
// Capability gate definitions
// ---------------------------------------------------------------------------

/**
 * Maps tool name → function that returns true when the tool should be included.
 * Tools absent from this map are ALWAYS included (fail-open).
 *
 * Supervisor tools: call_payments_agent, call_logistica_agent, call_contador_agent,
 *   call_customer_agent.
 * Customer Agent tools: create_payment_link, quote_shipping.
 * Ungated tools (always included): call_ventas_agent, call_communications_agent,
 *   call_customer_agent, call_caja_agent (DB-only — no external provider),
 *   get_catalog, lookup_or_create_customer,
 *   update_own_customer_data, send_reply_via_wpp, escalate_to_owner.
 */
const TOOL_GATES: Record<string, (ctx: ReadonlyContext) => boolean> = {
  // Supervisor — Payments requires at least one payment provider connected OR mock mode.
  call_payments_agent: (ctx) =>
    Boolean(ctx.state.get("app:mercadopago_connected", false)) ||
    Boolean(ctx.state.get("app:alias_cbu_set", false)) ||
    Boolean(ctx.state.get("app:mercadopago_mock", false)),
  // Supervisor — Logística requires Andreani credentials OR active mock mode.
  call_logistica_agent: (ctx) =>
    Boolean(ctx.state.get("app:andreani_connected", false)) ||
    Boolean(ctx.state.get("app:andreani_mock", false)),
  // Supervisor — Contador (fiscal) requires ARCA credentials.
  call_contador_agent: (ctx) =>
    Boolean(ctx.state.get("app:arca_connected", false)),
  // Supervisor — Customer Agent requires WhatsApp to be configured. Without a
  // WhatsApp number the Customer Agent has no reply channel; hiding the tool
  // prevents the LLM from invoking a dead-end path.
  call_customer_agent: (ctx) =>
    Boolean(ctx.state.get("app:whatsapp_business_connected", false)) ||
    Boolean(ctx.state.get("app:whatsapp_phone_set", false)),
  // Customer Agent — create_payment_link mirrors call_payments_agent gate.
  create_payment_link: (ctx) =>
    Boolean(ctx.state.get("app:mercadopago_connected", false)) ||
    Boolean(ctx.state.get("app:alias_cbu_set", false)) ||
    Boolean(ctx.state.get("app:mercadopago_mock", false)),
  // Customer Agent — quote_shipping mirrors call_logistica_agent gate.
  quote_shipping: (ctx) =>
    Boolean(ctx.state.get("app:andreani_connected", false)) ||
    Boolean(ctx.state.get("app:andreani_mock", false)),
};

// A no-op ToolPredicate used to satisfy BaseToolset constructor — actual filtering
// is done in getTools(), not via the toolFilter predicate.
const PASSTHROUGH_FILTER = () => true;

// ---------------------------------------------------------------------------
// CapabilityToolset
// ---------------------------------------------------------------------------

/**
 * ADK BaseToolset that filters the Supervisor's tool list based on app:* state flags.
 *
 * Pass the full tool list at construction time; getTools() returns the filtered
 * subset at request time using the ReadonlyContext populated by stateDelta.
 *
 * Tool names NOT in TOOL_GATES are always returned regardless of state (ungated tools
 * are fail-open by design: adding a new tool does not require updating this file unless
 * it has a provider gate).
 *
 * IMPORTANT — see getTools() for the full behavior matrix including the fail-closed branch.
 */
export class CapabilityToolset extends BaseToolset {
  private readonly allTools: BaseTool[];

  constructor(tools: BaseTool[]) {
    super(PASSTHROUGH_FILTER);
    this.allTools = tools;
  }

  /**
   * getTools(context?) returns the filtered tool list based on capability flags.
   *
   * Behavior matrix:
   * - context absent → all tools returned (fail-open for legacy callers without session context)
   * - context present + state has app:* keys → tools filtered per TOOL_GATES
   * - context present + state empty → all gated tools EXCLUDED (fail-closed)
   *   This is intentional: callers that establish a session MUST inject capabilities
   *   via stateDelta before invoking the runner. Empty state with present context is
   *   interpreted as "no capabilities configured" → minimal tool set exposed to LLM.
   *   A WARNING log is emitted to help operators diagnose missing capability injection.
   *
   * ADK ReadonlyContext.state.get(key, defaultValue) returns defaultValue when the key
   * is absent from both the session state delta and the persisted session state value.
   * Source: https://adk.dev/sessions/state/ (app:* prefix scope, verified in @google/adk dist).
   *
   * Called by ADK's convertToolUnionToTools() before each LLM invocation.
   * Source: https://adk.dev/tools-custom/
   */
  async getTools(context?: ReadonlyContext): Promise<BaseTool[]> {
    if (!context) return this.allTools; // No context → fail-open: return all.

    // Detect the fail-closed branch: context present but no app:* keys in state.
    // All known capability keys are probed; if none are truthy, no stateDelta was injected.
    // This indicates missing capability injection — log a WARNING so operators can diagnose.
    const APP_KEY_PROBES = [
      "app:mercadopago_connected",
      "app:alias_cbu_set",
      "app:mercadopago_mock",
      "app:andreani_connected",
      "app:andreani_mock",
      "app:arca_connected",
      "app:whatsapp_business_connected",
      "app:whatsapp_phone_set",
    ];
    const stateIsEmpty = APP_KEY_PROBES.every((k) => !context.state.get(k, false));
    if (stateIsEmpty) {
      // Fail-closed branch: gated tools (payments, logistica, contador) will all be excluded.
      // Callers MUST inject capabilities via stateDelta in runSupervisorAgentViaAdk().
      cloudLog({
        severity: "WARNING",
        // "Supervisor" is the owning component — CapabilityToolset is part of the Supervisor tool layer.
        component: "Supervisor",
        action: "CAPABILITY_STATE_EMPTY",
        a2a_transfer: false,
        message:
          "CapabilityToolset.getTools: context present but app:* state is empty. " +
          "All gated tools excluded (fail-closed). " +
          "Inject capabilities via stateDelta in runSupervisorAgentViaAdk.",
      });
    }

    return this.allTools.filter((tool) => {
      const gate = TOOL_GATES[tool.name];
      if (!gate) return true; // No gate → always include (ungated tools are fail-open).
      return gate(context);
    });
  }

  /** ADK lifecycle hook — no resources to release. */
  async close(): Promise<void> {
    // No-op: CapabilityToolset holds no external connections.
  }
}
