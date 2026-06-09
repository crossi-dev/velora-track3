import "server-only";
// customer-agent.ts — Customer Agent — canonical sub-agent of Supervisor.
//
// ## Canonical architecture (ADK 2026 single-coordinator pattern)
//
// Google ADK canonical pattern is SINGLE coordinator + sub-agents.
// Source: https://adk.dev/workflows/collaboration/
//   "a coordinator agent handles delegation of tasks to one or more subagents"
//
// Velora implements this as:
//   Supervisor (Gemini Pro, coordinator)
//     └─ Customer Agent (Gemini Flash, sub-agent) ← this file
//          Canonical entry path: Supervisor.call_customer_agent tool
//          (call-customer-agent-tool.ts → A2A → /api/agents/customer/jsonrpc)
//
// ## Runtime invocation paths
//
// PATH A — Owner asks about customer (canonical Supervisor delegation):
//   Owner chat → Supervisor → call_customer_agent tool → A2A → runCustomerAgent()
//
// PATH B — Inbound WPP customer message (Cloud Tasks worker, trusted-internal):
//   Twilio/Meta → /api/whatsapp/webhook → enqueue → /api/internal/tasks/whatsapp-inbound
//   → runCustomerAgent() directly (OIDC-auth; no Supervisor needed, no latency added)
//
// PATH B is architecturally valid because the Cloud Tasks worker is internally
// trusted (OIDC) and does not need Supervisor orchestration for a pure B2C turn.
// The Customer Agent remains a Supervisor sub-agent conceptually — PATH A is the
// canonical delegation route. PATH B is an optimised direct call.
//
// ADK multi-tenant session model (https://adk.dev/sessions/state/):
//   app_name  = businessId  (tenant scope)
//   user_id   = customerPhone  (customer identity within tenant)
//
// Wiesinger §3.2 sub-agent specialization:
//   https://www.kaggle.com/whitepaper-agents

import { Runner, isFinalResponse } from "@google/adk";
import { createAdkAgent } from "./agent-factory";
import { getAdkCustomerModel } from "./gemini-config";
import { cloudLog } from "@/lib/cloud-logger";
import { buildCustomerAgentTools } from "./customer-agent-tools-a2a";
import { CapabilityToolset } from "./capability-toolset";
import { buildCapabilityStateDelta } from "@/app/api/supervisor/_lib/supervisor-runner.capabilities";
import {
  CUSTOMER_AGENT_SYSTEM_PROMPT,
  CATALOG_SUMMARY_PLACEHOLDER,
  CUSTOMER_PROFILE_PLACEHOLDER,
} from "./customer-agent.prompt";
import { buildCatalogSummary } from "./customer-agent-catalog";
import { loadCustomerProfile } from "./customer-agent-profile";
import { applyNoStockGuard } from "./customer-agent-nostock-guard";
import {
  StatefulCustomerSessionService,
  loadCustomerAgentSessionState,
  saveCustomerAgentSessionState,
} from "./customer-agent-session-state";
import { prisma } from "@/lib/prisma";
import type { CustomerAgentInput, CustomerAgentResult } from "./customer-agent-types";
import { getAgentsBaseUrl } from "@/lib/agent-base-url";

// ADK timeout for the Customer Agent. Flash model — faster than Pro, but the
// full checkout chain (lookup_or_create_customer → get_catalog → quote_shipping
// → create_payment_link) is 3 A2A calls + Flash reasoning per step:
//   shipping quote ~12s + Payments ADK ~60s + inter-step reasoning ~15s = ~87s.
// Raised to 90s (2026-05-29) from 60s so the full checkout chain fits.
// Hierarchy: ADK inner (90s) ≤ dispatch outer (100s) ≤ route maxDuration (100s). ✓
// Cloud Run override: CUSTOMER_AGENT_ADK_TIMEOUT_MS=90000.
const CUSTOMER_AGENT_ADK_TIMEOUT_MS = Number(
  process.env.CUSTOMER_AGENT_ADK_TIMEOUT_MS ?? "90000",
);

/**
 * Run the Customer Agent for a single customer turn.
 *
 * Stateless per-request — no shared mutable state between calls.
 * ADK InMemoryRunner provides session isolation per (app_name, user_id).
 *
 * @returns CustomerAgentResult with text reply and optional structured data.
 */
export async function runCustomerAgent(
  input: CustomerAgentInput,
): Promise<CustomerAgentResult> {
  const { businessId, customerPhone, text, inboundMessageId } = input;
  // appUrl → A2A JSON-RPC URLs only (/api/agents/payments, /api/agents/communications).
  // NOT used for customer-facing URLs. Phase B cutover to agents.somosvelora.com is safe.
  const appUrl = getAgentsBaseUrl();
  const toolCtx = { businessId, customerPhone, appUrl, inboundMessageId };

  // Step H1: wrap tools in CapabilityToolset so ADK filters by app:* state flags.
  // create_payment_link is hidden when MP is not connected.
  // quote_shipping is hidden when Andreani is not connected.
  // Always-on: get_catalog, lookup_or_create_customer, update_own_customer_data,
  //             send_reply_via_wpp, escalate_to_owner.
  // Source: https://adk.dev/tools-custom/ — BaseToolset.getTools(context) pattern.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- BaseTool[] cast; buildCustomerAgentTools returns FunctionTool[].
  const capabilityToolset = new CapabilityToolset(buildCustomerAgentTools(toolCtx) as any[]);

  // Load capability state for this tenant — same helper as Supervisor.
  // Returns app:* flags: mercadopago_connected, andreani_connected, etc.
  const capStateDelta = await buildCapabilityStateDelta(businessId);

  // ── Catalog context injection ────────────────────────────────────────────────
  // Build a compact catalog summary and inject it into the system instruction so
  // the model has real product/price/stock data on turn 1. This prevents
  // hallucinated "no tenemos X" for existing products or "carrito vacío" for an
  // active order — without mode=ANY which breaks final text replies.
  // Sources (verified HTTP 200 2026-05-29):
  //   https://ai.google.dev/gemini-api/docs/function-calling (AUTO vs ANY — why not ANY)
  //   https://adk.dev/sessions/state/ (InstructionProvider pattern — callback closure)
  const catalogSummary = await buildCatalogSummary(businessId);

  // ── Load persisted cart state + saved profile ────────────────────────────────
  // Resolve customerId so we can load/save state keyed by (businessId, customerId).
  // loadCustomerProfile also returns the injectable summary so the agent stops
  // re-asking name/address/CP it already has (mirrors the catalog injection).
  const { row: customerRow, summary: customerProfileSummary } = await loadCustomerProfile(businessId, customerPhone);
  const customerId = customerRow?.id ?? null;

  const savedState = customerId
    ? await loadCustomerAgentSessionState(businessId, customerId)
    : {};

  const agent = createAdkAgent({
    name: "velora_customer_agent",
    // description is required for AgentTool compatibility — if this agent is ever
    // wired as a sub-agent via AgentTool on the Supervisor, the Supervisor's LLM
    // uses this text to decide when to delegate.
    // Source: https://adk.dev/workflows/collaboration/ — coordinator sub-agent pattern.
    description:
      "Handles inbound customer WhatsApp conversations for this business: " +
      "catalog queries, shipping quotes, payment links, and customer data updates. " +
      "Delegate here when the owner asks about customer interactions or when a " +
      "customer message must be processed on behalf of the business.",
    model: getAdkCustomerModel(),
    // Inject the catalog summary into the instruction via a closure.
    // createAdkAgent() wraps this as a callback (agent-factory.ts) so ADK template
    // resolution ({identifier} syntax) is bypassed — no risk of JSON brace crash.
    // The catalogSummary is fetched from DB above (real data, this request's tenant).
    instruction: CUSTOMER_AGENT_SYSTEM_PROMPT
      .replaceAll(CATALOG_SUMMARY_PLACEHOLDER, catalogSummary)
      .replaceAll(CUSTOMER_PROFILE_PLACEHOLDER, customerProfileSummary),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- CapabilityToolset satisfies BaseTool[] at runtime; ADK checks isBaseToolset() symbol.
    tools: [capabilityToolset as any],
    generateContentConfig: {
      // Budget chosen to cover the full checkout chain reply (address ack +
      // shipping cost line + items breakdown + payment link + closing).
      // Previous 800 tripped mid-sentence ("Por los 3 alfajores y el envío, el")
      // on Carlos's 2026-05-28 18:41 UTC turn.
      maxOutputTokens: 1500,
      // NO toolConfig → Gemini defaults to AUTO mode: the model can call tools AND
      // still emit a final text reply. mode=ANY was REVERTED (2026-05-29): it forces
      // a function call on EVERY turn, so the model never produces final text →
      // CUSTOMER_AGENT_EMPTY_REPLY loop ("No pude generar una respuesta") in prod.
      // Grounding is done instead by injecting the real catalog summary into the
      // instruction (see catalogSummary above) — the model always has true data.
      // Source (verified HTTP 200 2026-05-29):
      //   https://ai.google.dev/gemini-api/docs/function-calling
      //   "AUTO — The model decides whether to generate a natural language response
      //    or suggest a function call based on the prompt and context."
    },
  });

  // Canonical ADK 2026: base Runner + StatefulCustomerSessionService (Postgres-backed,
  // captures live session state post-run). C1 fix: inboundMessageId excludes the
  // current inbound row from session history (runner injects it via newMessage).
  // Sources: https://google.github.io/adk-docs/sessions/session/ + /state/
  const sessionService = new StatefulCustomerSessionService(businessId, inboundMessageId);
  const runner = new Runner({
    appName: businessId,
    agent,
    sessionService,
  });

  // user_id = customerPhone (E.164 — triggers customer-session branch in
  //   ChatMessageSessionService.getSession).
  // session_id is stable per customer thread so Runner reuses the same Session
  //   object across requests.
  const userId = customerPhone;
  const sessionId = `customer-${customerPhone.replace(/[^A-Za-z0-9]/g, "")}`;

  // Pre-create the session so Runner.runAsync finds an existing session via
  // getSession (it throws "Session not found" if getSession returns undefined
  // for a customer with zero ChatMessage history).
  // NOTE: createSession state parameter is intentionally NOT used for state
  // injection because ADK's Runner.runAsync calls getSession (not createSession)
  // to get the live session object — the state injected here would be lost.
  // Actual state injection happens via stateDelta below (the only correct vector).
  // Source: Runner.runAsync source (node_modules/@google/adk/dist/cjs/runner/runner.js
  //   line ~121): calls this.sessionService.getSession which returns state: {}
  //   from loadCustomerThreadSession. stateDelta is applied via appendEvent
  //   (BaseSessionService.updateSessionState) onto that session object.
  await sessionService.createSession({
    appName: businessId,
    userId,
    sessionId,
    state: {},
  });

  // Build the combined stateDelta: saved cart state merged with fresh cap flags.
  // capStateDelta wins on key conflict to ensure freshly disconnected integrations
  // are reflected (never serve a cached capability flag).
  // Source: https://google.github.io/adk-docs/sessions/state/ — stateDelta is
  // the canonical ADK mechanism to inject initial state into a runAsync call.
  // Fix B: inject customer identity (turn-1 tool anchor) — savedState wins on user:* for turn 2+.
  const initialState: Record<string, unknown> = { ...(customerId ? { "user:customer_id": customerId, "user:customer_name": customerRow?.name ?? "" } : {}), ...savedState, ...capStateDelta };

  let finalText = "";
  // Warm human fallback (cold start / timeout / empty reply) — a shop owner who stepped away, not a robot.
  const BUSY_REPLY = "¡Perdón! Estaba atendiendo a otra persona y se me complicó. ¿Me repetís lo que necesitabas? 🙏";
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(
      () => reject(Object.assign(new Error("Customer Agent timed out"), { name: "TimeoutError" })),
      CUSTOMER_AGENT_ADK_TIMEOUT_MS,
    );
  });

  const events = runner.runAsync({
    userId,
    sessionId,
    newMessage: { role: "user", parts: [{ text }] },
    runConfig: { maxLlmCalls: 10 },
    // stateDelta is the only vector that actually reaches the session object —
    // createSession state is NOT used by runAsync. Source: /adk-docs/sessions/state/
    ...(Object.keys(initialState).length > 0 ? { stateDelta: initialState } : {}),
  });

  const drainEvents = async () => {
    for await (const event of events) {
      if (!isFinalResponse(event)) continue;
      for (const part of event.content?.parts ?? []) {
        if (typeof part.text === "string" && part.text.length > 0) {
          finalText = part.text;
        }
      }
      break; // Exit on first final-response (same pattern as supervisor-agent.ts)
    }
  };

  try {
    await Promise.race([drainEvents(), timeoutPromise]);
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === "TimeoutError";
    cloudLog({
      severity: "ERROR",
      component: "CustomerAgent",
      action: isTimeout ? "CUSTOMER_AGENT_TIMEOUT" : "CUSTOMER_AGENT_ERROR",
      a2a_transfer: false,
      message: isTimeout
        ? `Customer Agent timed out after ${CUSTOMER_AGENT_ADK_TIMEOUT_MS}ms`
        : `Customer Agent threw: ${err instanceof Error ? err.message : String(err)}`,
      data: { businessId, customerPhone },
    });
    finalText = BUSY_REPLY;
  } finally {
    if (timeoutHandle !== null) clearTimeout(timeoutHandle);
    try { await events.return(undefined); } catch { /* already exhausted */ }
  }

  // ── Post-reply no-stock hallucination guard ─────────────────────────────────
  // Deterministic backstop: if Flash denied stock for a product that appears in
  // catalogSummary with quantity > 0, replace the reply with an affirmative line.
  // Safe for legit zero-stock: guard stays silent when the denial is correct.
  if (finalText) {
    const g = applyNoStockGuard(finalText, catalogSummary, text, businessId, customerPhone);
    if (g.fired) finalText = g.text;
  }

  // ── Persist durable cart state ───────────────────────────────────────────────
  // Fix (2026-05-29): brand-new customers have customerId=null pre-run (row is
  // created by lookup_or_create_customer during the run). Re-fetch post-run so
  // state is saved. Non-fatal — a failure just means next turn starts empty.
  let effectiveCustomerId: string | null = customerId;
  if (!effectiveCustomerId) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Prisma regen blocked on Windows DLL lock.
      const row = await (prisma as any).customer.findFirst({ where: { businessId, phone: customerPhone }, select: { id: true } }) as { id: string } | null;
      effectiveCustomerId = row?.id ?? null;
    } catch { /* non-fatal — skip save, next turn starts with empty state */ }
  }
  if (effectiveCustomerId) {
    await saveCustomerAgentSessionState(businessId, effectiveCustomerId, sessionService.capturedState);
  }

  if (!finalText) {
    cloudLog({
      severity: "ERROR",
      component: "CustomerAgent",
      action: "CUSTOMER_AGENT_EMPTY_REPLY",
      a2a_transfer: false,
      message: "Customer Agent completed without producing a final text response",
      data: { businessId, customerPhone },
    });
  }

  return {
    text: finalText || BUSY_REPLY,
  };
}
