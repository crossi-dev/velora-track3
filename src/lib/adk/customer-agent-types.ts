// customer-agent-types.ts — Input/output contract for the Customer Agent Coordinator.
//
// The Customer Agent is the B2C-side ADK Coordinator for Velora. It handles
// inbound customer interactions delegated from the Supervisor via A2A.
//
// Scope (per decision/customer-agent-scope-reduced — 2026-05-28):
//   IN:  ADK Coordinator + restricted tools + Supervisor's call_customer_agent.
//   OUT: WhatsApp webhook plumbing, CustomerConversation table, Meta 24h session
//        window, WABA token management. All deferred.
//
// ADK multi-tenant session model (https://adk.dev/sessions/state/):
//   app_name  = businessId (tenant scope)
//   user_id   = customerPhone (customer identity within tenant)
//   session_id = synthesized from phone when absent
//
// A2A Protocol v1.0: https://a2a-protocol.org/latest/specification/

// ── ChipsBundle (minimal — mirrors supervisor-chips.ts without importing it) ──

export interface CustomerChip {
  label: string;
  value: string;
}

export interface CustomerChipsBundle {
  kind: "single";
  options: CustomerChip[];
}

// ── Customer-side action types ─────────────────────────────────────────────────

/**
 * Structured action produced by the Customer Agent alongside the text reply.
 * The A2A caller (Supervisor or future webhook handler) uses these to drive
 * post-response side-effects (e.g. stamp customerPhone on a PaymentIntent row).
 */
export type CustomerSideAction =
  | { type: "customer_identified"; customerId: string; customerPhone: string; isNew: boolean }
  | { type: "payment_link_created"; checkoutUrl: string; paymentIntentId: string }
  | { type: "escalated_to_owner"; reason: string };

// ── Input / output contracts ───────────────────────────────────────────────────

/**
 * Input to the Customer Agent runner.
 *
 * The caller (Supervisor via call_customer_agent, or future webhook handler)
 * resolves businessId and customerPhone before invoking the agent.
 * The agent never guesses these — they come from the A2A message envelope.
 */
export interface CustomerAgentInput {
  /** Velora tenant business ID (CUID). */
  businessId: string;
  /** Customer phone in E.164 format (e.g. "+5492612345678"). */
  customerPhone: string;
  /** Free-text message from the customer. */
  text: string;
  /**
   * Optional ADK session ID. When absent the agent synthesizes one from
   * businessId + customerPhone for stateful multi-turn conversations.
   * Source: https://adk.dev/sessions/state/ (user_id + app_name scoping)
   */
  sessionId?: string;
  /**
   * Optional inbound message ID (e.g. Twilio/Meta SID).
   * When set, the session-history loader excludes the ChatMessage row with
   * clientMessageId="wpp-in-{inboundMessageId}" so the current turn does not
   * appear twice (once in history and once as newMessage). C1 fix 2026-05-29.
   */
  inboundMessageId?: string;
}

/**
 * Output from the Customer Agent runner.
 *
 * `text` is the reply to send back to the customer.
 * `chips` and `actions` are optional structured payloads.
 */
export interface CustomerAgentResult {
  /** Reply text for the customer. */
  text: string;
  /** Optional tappable chips (same wire format as Supervisor chips). */
  chips?: CustomerChipsBundle;
  /** Structured side-effects for the caller to process. */
  actions?: CustomerSideAction[];
}
