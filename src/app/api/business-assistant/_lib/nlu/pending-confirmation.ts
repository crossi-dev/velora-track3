// Helper to inspect chat history for a pending confirmationRequest.
//
// The previous assistant turn may have emitted a confirmationRequest card
// (delete_product, undo, bulk_price_update, etc.). When the next user turn
// arrives the server needs to know whether a confirmation is pending so
// `confirmation-response.ts` can short-circuit sí/no without invoking the
// LLM.
//
// Today the confirmationRequest payload is NOT persisted in ChatMessage —
// it lives only in client React state. The /api/business-assistant route
// accepts an optional `confirmationRequest` field per chatHistory entry
// (see route.ts) and forwards it on the most-recent assistant turn so
// this helper can read it. If the client did not attach the payload, the
// helper returns null and the pipeline falls through to the LLM as before.

import type { AssistantDestructiveAction } from "@/app/dashboard/lib/assistant-action.types";

export interface PendingConfirmationCarrier {
  role: "user" | "assistant";
  text: string;
  confirmationRequest?: {
    id?: string;
    severity?: "warning" | "critical";
    title?: string;
    message?: string;
    confirmLabel?: string;
    cancelLabel?: string;
    action: AssistantDestructiveAction;
  } | null;
}

export interface PendingConfirmation {
  id: string | null;
  action: AssistantDestructiveAction;
  message: string | null;
}

// Walks the recent history backwards looking for the most recent assistant
// turn. If that turn carries a confirmationRequest payload, returns it; if
// the most recent assistant turn carried no confirmation, returns null
// (the assistant has moved on; an older pending request is no longer in
// play).
export function getPendingConfirmation(
  recentHistory: readonly PendingConfirmationCarrier[] | undefined,
): PendingConfirmation | null {
  if (!Array.isArray(recentHistory) || recentHistory.length === 0) return null;

  for (let i = recentHistory.length - 1; i >= 0; i -= 1) {
    const entry = recentHistory[i];
    if (!entry || entry.role !== "assistant") continue;
    const req = entry.confirmationRequest;
    if (!req || !req.action || typeof req.action.type !== "string") return null;
    return {
      id: typeof req.id === "string" ? req.id : null,
      action: req.action,
      message: typeof req.message === "string" ? req.message : null,
    };
  }

  return null;
}
