import "server-only";
// customer-agent-session-state.ts — Persist/restore the Customer Agent's durable
// cart state across stateless Cloud Tasks worker invocations.
//
// Problem: ADK session.state is in-memory per Runner construction. Every Cloud
// Tasks invocation creates a fresh Runner, so multi-message orders lose their
// cart between turns ("quiero 3 alfajores" msg 1 → "dale, pagá" msg 2, cart empty).
//
// Solution:
//   1. Before the run: load Customer.agentSessionState and inject it as the
//      initial session state (merged into createSession's state param).
//   2. During the run: StatefulCustomerSessionService captures the live session
//      object via appendEvent so post-run state is accessible.
//   3. After the run: extract the durable subset (cart + user:* keys) and persist
//      back to Customer.agentSessionState. Non-fatal — a save failure never
//      breaks the reply.
//
// app:* capability flags are NOT persisted — they are recomputed per-turn by
// buildCapabilityStateDelta() and would become stale if cached.
//
// Sources (verified HTTP 200):
//   https://google.github.io/adk-docs/sessions/state/ — state prefix semantics
//   https://stripe.com/guides/agentic-commerce          — deterministic cart pattern

import type { AppendEventRequest, Event, GetSessionRequest, Session } from "@google/adk";
import { prisma } from "@/lib/prisma";
import { cloudLog } from "@/lib/cloud-logger";
import { ChatMessageSessionService } from "./session-service";
import { loadCustomerThreadSession } from "./session-service.customer";

// Keys that represent the durable order/cart and customer identity across turns.
// user:* prefix → ADK semantics: persists across sessions for the same user.
// order + shipping_cost → session-scoped cart, cleared after successful payment.
export const DURABLE_STATE_KEYS = [
  "order",
  "shipping_cost",
  "user:customer_id",
  "user:customer_name",
  "user:address_set",
  "user:last_catalog_view",
] as const;

// State older than 24h is discarded (stale cart guard). Avoids yesterday's
// cart resurfacing for a new conversation the next morning.
const STATE_TTL_MS = 24 * 60 * 60 * 1000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Prisma regen blocked on Windows DLL lock; Cloud Build runs prisma generate fresh.
const db = prisma as any;

/**
 * StatefulCustomerSessionService — extends ChatMessageSessionService to capture
 * the live session object during appendEvent, enabling post-run state extraction.
 *
 * Design: ADK's Runner mutates session.state in-place during runAsync via
 * BaseSessionService.updateSessionState (called from appendEvent). By holding a
 * reference to the session object we can read its final state after the run
 * without requiring any changes to the Runner or the tool implementations.
 *
 * This class is ONLY used by runCustomerAgent — all other session paths (owner,
 * employee, supervisor) continue to use ChatMessageSessionService directly.
 */
export class StatefulCustomerSessionService extends ChatMessageSessionService {
  // Captured after the first appendEvent call; mutated in-place thereafter.
  private _capturedSession: { state: Record<string, unknown> } | null = null;

  /**
   * C1 fix (2026-05-29): when set, getSession excludes this inbound message
   * from history so the current turn doesn't appear twice (history + newMessage).
   */
  private readonly _excludeInboundMessageId: string | undefined;

  constructor(businessId: string, excludeInboundMessageId?: string) {
    // Pass agentName="velora_customer_agent" to the parent constructor so any
    // session-service path that reaches super.getSession (e.g. future non-customer
    // branch additions) also uses the correct author instead of the default
    // "velora_supervisor". The customer branch in getSession below still passes
    // "velora_customer_agent" explicitly for clarity and defense-in-depth.
    super(businessId, "velora_customer_agent");
    this._excludeInboundMessageId = excludeInboundMessageId;
  }

  /** Returns the final session state after the run, or {} if no events fired. */
  get capturedState(): Record<string, unknown> {
    return this._capturedSession?.state ?? {};
  }

  override async getSession(request: GetSessionRequest): Promise<Session | undefined> {
    // Customer-thread branch: userId is the customer phone (E.164, always "+" prefix
    // after normalization at the worker boundary) OR sessionId starts with "customer-"
    // (belt-and-suspenders: catches any caller that bypasses the worker normalization).
    // Root cause fix (2026-05-29): Meta Cloud API delivered bare digits — without the
    // sessionId guard the branch was never taken → super.getSession returned nothing
    // for a freshly pre-created session → ADK threw "Session not found".
    const isCustomerThread =
      request.userId.startsWith("+") ||
      request.sessionId.startsWith("customer-");
    if (isCustomerThread) {
      const limit = request.config?.numRecentEvents ?? 30;
      return loadCustomerThreadSession(
        this.businessId,
        request,
        limit,
        this._excludeInboundMessageId,
        // C2 fix: must be the exact agent name so ADK event.author contract is met.
        // ADK isEventFromAnotherAgent: author !== agentName → foreign event → EMPTY_REPLY.
        // Source: https://adk.dev/events/ + ADK content_processor_utils.js lines 108-109
        "velora_customer_agent",
      );
    }
    return super.getSession(request);
  }

  override async appendEvent(request: AppendEventRequest): Promise<Event> {
    // Capture the session reference before super mutates it, so we always hold
    // the same object (super.appendEvent updates session.state in-place).
    if (!this._capturedSession) {
      this._capturedSession = request.session as { state: Record<string, unknown> };
    }
    return super.appendEvent(request);
  }
}

/** Load saved agent session state for a customer. Returns {} if none or expired. */
export async function loadCustomerAgentSessionState(
  businessId: string,
  customerId: string,
): Promise<Record<string, unknown>> {
  try {
    const row = await db.customer.findFirst({
      where: { id: customerId, businessId },
      select: { agentSessionState: true, agentSessionStateUpdatedAt: true },
    });
    if (!row?.agentSessionState) return {};

    const updatedAt: Date | null = row.agentSessionStateUpdatedAt ?? null;
    if (updatedAt && Date.now() - updatedAt.getTime() > STATE_TTL_MS) {
      cloudLog({
        severity: "INFO",
        component: "CustomerAgent",
        action: "CUSTOMER_AGENT_STATE_EXPIRED",
        a2a_transfer: false,
        message: "Customer agent session state expired (>24h) — starting fresh",
        data: { businessId, customerId },
      });
      return {};
    }

    return (row.agentSessionState as Record<string, unknown>) ?? {};
  } catch (err) {
    cloudLog({
      severity: "WARNING",
      component: "CustomerAgent",
      action: "CUSTOMER_AGENT_STATE_LOAD_ERROR",
      a2a_transfer: false,
      message: `Failed to load agent session state: ${err instanceof Error ? err.message : String(err)}`,
      data: { businessId, customerId },
    });
    return {};
  }
}

/**
 * Extract only the durable keys from an ADK session state object.
 * app:* capability flags are deliberately excluded — those are recomputed
 * each turn by buildCapabilityStateDelta() and must not be cached.
 */
export function extractDurableState(
  state: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of DURABLE_STATE_KEYS) {
    if (state[key] !== undefined) {
      result[key] = state[key];
    }
  }
  return result;
}

/** Persist the durable subset of the post-run session state to the Customer row. */
export async function saveCustomerAgentSessionState(
  businessId: string,
  customerId: string,
  state: Record<string, unknown>,
): Promise<void> {
  const durable = extractDurableState(state);

  // Clear the column when the cart is empty AND no user:* keys are set — saves
  // storage and makes TTL checks cheaper on the next load.
  const orderItems = (durable.order as { items?: unknown[] } | undefined)?.items;
  const cartEmpty = !orderItems || orderItems.length === 0;
  const hasUserKeys = DURABLE_STATE_KEYS.filter((k) => k.startsWith("user:")).some(
    (k) => durable[k] !== undefined,
  );
  const stateToSave = cartEmpty && !hasUserKeys ? null : durable;

  try {
    await db.customer.updateMany({
      where: { id: customerId, businessId },
      data: {
        agentSessionState: stateToSave,
        agentSessionStateUpdatedAt: new Date(),
      },
    });
  } catch (err) {
    // Non-fatal: a save failure means the next turn starts with an empty cart.
    // Never throw here — a state persistence failure must not break the reply.
    cloudLog({
      severity: "WARNING",
      component: "CustomerAgent",
      action: "CUSTOMER_AGENT_STATE_SAVE_ERROR",
      a2a_transfer: false,
      message: `Failed to save agent session state: ${err instanceof Error ? err.message : String(err)}`,
      data: { businessId, customerId },
    });
  }
}
