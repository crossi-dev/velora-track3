"use client";

// useAssistantChat.errorDispatch.ts — error classification dispatch helpers for handleGo.
// Extracted from useAssistantChat.ts to push that file below the 400-line warning threshold.
//
// Handles the result.kind === "error" branch: offline re-enqueue, lastFailedInputRef
// tracking, and the window NETWORK_ERROR event dispatch.

import type { MutableRefObject } from "react";
import { enqueue as enqueueOffline, notifyChanged as notifyOfflineQueueChanged } from "../offline-queue";
import { CHAT_EVENT } from "../chat-events";
import type { classifyErrorForUser } from "./useAssistantChat.errors";

type ClassifiedError = ReturnType<typeof classifyErrorForUser>;

export interface ErrorDispatchContext {
  businessId: string | null;
  candidateText: string | undefined;
  continueAssistantQuestion: boolean;
  idempotencyKey: string;
  lastFailedInputRef: MutableRefObject<{ text: string; idempotencyKey: string } | null>;
  boundEmitErrorOnce: (text: string, alsoSetParseError?: boolean) => void;
}

/**
 * Handles the classified error from a failed chat request:
 * - Saves the failed input for retry if the error is retryable.
 * - Re-enqueues offline if the browser went offline mid-request.
 * - Emits the error into the chat history once (via boundEmitErrorOnce).
 * - Dispatches a window NETWORK_ERROR custom event for UI retry CTAs.
 */
export function dispatchClassifiedError(
  classified: ClassifiedError,
  errorMessage: string,
  ctx: ErrorDispatchContext,
): void {
  const failed = ctx.candidateText?.trim() || null;

  if (classified.kind === "network") {
    if (failed) {
      ctx.lastFailedInputRef.current = { text: failed, idempotencyKey: ctx.idempotencyKey };
    }
    // If the browser went offline during the request, enqueue so we
    // don't lose the sale. Reuse the same idempotency key so a
    // partial server write is deduped on replay.
    const stillOffline = typeof navigator !== "undefined" && navigator.onLine === false;
    if (stillOffline && failed) {
      enqueueOffline({
        type: "assistant.chat",
        payload: {
          text: failed,
          continueAssistantQuestion: ctx.continueAssistantQuestion,
          businessId: ctx.businessId,
        },
        idempotencyKey: ctx.idempotencyKey,
      });
      notifyOfflineQueueChanged();
    }
    ctx.boundEmitErrorOnce(classified.message);
  } else if (classified.kind === "server") {
    if (failed) {
      ctx.lastFailedInputRef.current = { text: failed, idempotencyKey: ctx.idempotencyKey };
    }
    ctx.boundEmitErrorOnce(classified.message);
  } else if (classified.kind === "client") {
    // Not retryable — do not set lastFailedInputRef.
    ctx.lastFailedInputRef.current = null;
    ctx.boundEmitErrorOnce(classified.message);
  } else {
    ctx.boundEmitErrorOnce(errorMessage);
  }

  // Hint event so UI layers can wire up a retry CTA without tight
  // coupling to this hook.
  if (typeof window !== "undefined") {
    try {
      window.dispatchEvent(
        new CustomEvent(CHAT_EVENT.NETWORK_ERROR, {
          detail: {
            message: classified.message,
            canRetry: classified.canRetry && !!failed,
            kind: classified.kind,
          },
        })
      );
    } catch (dispatchErr) {
      console.warn("[assistant-chat] network-error-dispatch failed:", dispatchErr);
    }
  }
}
