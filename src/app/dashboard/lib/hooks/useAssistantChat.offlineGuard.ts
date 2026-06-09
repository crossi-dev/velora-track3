"use client";

// useAssistantChat.offlineGuard.ts — offline short-circuit for handleGo.
// Extracted from useAssistantChat.ts to keep that file under the 320-line warning threshold.
//
// Checks navigator.onLine before every request. If offline, enqueues the message
// in IndexedDB and surfaces a user-facing notice without touching the AI path.

import { enqueue as enqueueOffline, notifyChanged as notifyOfflineQueueChanged, size as offlineQueueSize } from "../offline-queue";
import { tLang } from "../DashboardLangContext";
import { safeNewUuid } from "./useAssistantChat.idempotency-keys";

export interface OfflineGuardContext {
  businessId: string | null;
  candidateText: string;
  continueAssistantQuestion: boolean;
  replayKey: string | undefined;
  appendChatHistoryEntry: (kind: "user" | "error" | "reply", text: string) => void;
  setInput: (v: string) => void;
}

/**
 * Returns true when the browser is offline and the message was queued.
 * The caller should `return` immediately when this is true.
 */
export function handleOfflineGuard(ctx: OfflineGuardContext): boolean {
  const isOnline = typeof navigator === "undefined" ? true : navigator.onLine !== false;
  if (isOnline) return false;
  if (!ctx.candidateText.trim()) return false;

  const queuedText = ctx.candidateText.trim();
  ctx.appendChatHistoryEntry("user", queuedText);
  ctx.setInput("");
  enqueueOffline({
    type: "assistant.chat",
    payload: {
      text: queuedText,
      continueAssistantQuestion: ctx.continueAssistantQuestion,
      businessId: ctx.businessId,
    },
    idempotencyKey: ctx.replayKey ?? safeNewUuid(),
  });
  notifyOfflineQueueChanged();
  const queueLen = offlineQueueSize();
  // Chat messages are scrubbed before persistence (text set to "") and
  // therefore cannot be auto-replayed. Do NOT promise automatic send.
  const notice =
    queueLen > 1
      ? tLang(`No connection (${queueLen} queued). Reconnect and resend the message manually.`, `Sin conexión (${queueLen} en cola). Reconectate y reenvialo manualmente.`)
      : tLang("No connection. Reconnect and resend the message manually.", "Sin conexión. Reconectate y reenviá el mensaje manualmente.");
  ctx.appendChatHistoryEntry("error", notice);
  return true;
}
