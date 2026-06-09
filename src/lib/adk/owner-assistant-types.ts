// owner-assistant-types.ts — Input/output contract for the Owner Assistant ADK agent.
//
// Phase 1: handles 3 extraction intents (create_product, stock_load, adjust_stock).
// Flag-gated behind USE_OWNER_ASSISTANT=true (default OFF).
// When flag is OFF or the agent produces no tool call, falls through to Supervisor.

/** Input to the Owner Assistant runner. */
export interface OwnerAssistantInput {
  /** Velora tenant business ID (CUID). */
  businessId: string;
  /** Owner user ID (actorUserId from session). */
  actorUserId: string;
  /** Free-text message from the owner. */
  text: string;
}

/**
 * Tool call extracted from the ADK event stream.
 * Shape mirrors what Ventas tools return so supervisor-action-mapper handles it unchanged.
 */
export interface OwnerAssistantToolCall {
  intent: string;
  data: Record<string, unknown>;
  summary: string;
}

/**
 * Output from the Owner Assistant runner.
 *
 * `toolCall` carries the extracted intent when the model called a tool.
 * `text` carries the model's conversational reply (may be empty when a tool call was made).
 * When both are null/empty the stage returns null → falls through to Supervisor.
 */
export interface OwnerAssistantResult {
  toolCall: OwnerAssistantToolCall | null;
  text: string;
}
