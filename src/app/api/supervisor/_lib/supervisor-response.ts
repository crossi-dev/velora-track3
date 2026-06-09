import type { SupervisorNotification } from "@/lib/supervisor-types";
import type { ChipsBundle } from "./supervisor-chips";
import type { PatternCIntent } from "@/lib/adk/tools/_shared/create-a2a-agent-tool";

export interface SupervisorResponse {
  kind: "actions" | "clarification" | "answer" | "notification";
  answer: string;
  actions: Array<{ intent: string; data: unknown; summary: string }> | null;
  clarification: { question: string; context: string } | null;
  notification: SupervisorNotification | null;
  // Tappable chips rendered under the assistant message. Optional, additive
  // to the existing answer/clarification/actions shape — the message body
  // still describes the question, the chips are visual shortcuts.
  chips?: ChipsBundle | null;
  usedModel: "gemini";
  // Set to true when the Supervisor delegated to a role-agent in-band via ADK
  // tools (call_contador_agent / call_ventas_agent / call_logistica_agent). Used by owner-handler to
  // skip the blind executeAgentCallActions fallback path — prevents double-send.
  usedAdkDelegation?: boolean;
  /**
   * Pattern C intents captured from sub-agent dataParts on the ADK delegation path.
   * Populated when usedAdkDelegation=true and at least one Pattern C agent
   * (ventas, communications, inventario) returned dataParts. executeSupActions
   * inlines these into supResult.actions before resolveCompoundActions runs so
   * the existing mutation pipeline materializes them identically to the non-ADK path.
   * Empty array (never undefined) when no Pattern C intents were emitted.
   */
  capturedPatternCIntents?: PatternCIntent[];
}

export type { ChipsBundle, ChipOption, ChipKind, ChipAction } from "./supervisor-chips";
