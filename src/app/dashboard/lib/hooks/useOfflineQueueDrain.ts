"use client";

import { useEffect, useRef } from "react";
import type React from "react";
import { CHAT_EVENT } from "../chat-events";
import {
  getAll as getAllOffline,
  pop as popOffline,
  bumpAttempts as bumpOfflineAttempts,
  markFailed as markOfflineFailed,
  notifyChanged as notifyOfflineQueueChanged,
  tryAcquireDrainLock,
  releaseDrainLock,
  MAX_REPLAY_ATTEMPTS,
} from "../offline-queue";
import type { QueuedAction } from "../offline-queue";
import { dispatchQueuedMutation } from "./useOfflineQueueDispatch";
import type { ChatHistoryEntry } from "../types";
import { tLang } from "../DashboardLangContext";

type HandleGoRef = React.MutableRefObject<
  (
    text?: string,
    continueAssistantQuestion?: boolean,
    replayKey?: string
  ) => Promise<string | void | undefined>
>;

export interface UseOfflineQueueDrainOptions {
  handleGoRef: HandleGoRef;
  inFlightRef: React.MutableRefObject<boolean>;
  drainingRef: React.MutableRefObject<boolean>;
  appendChatHistoryEntry: (kind: ChatHistoryEntry["kind"], text: string) => void;
  setParseError: (msg: string | null) => void;
  retryLastFailedAction: () => boolean;
}

/**
 * Owns the offline-queue replay lifecycle:
 *   • On browser `online` event: flush the queue sequentially through
 *     handleGo, per-item attempts capped at MAX_REPLAY_ATTEMPTS.
 *   • Yields to any user-initiated request (inFlightRef) and to the
 *     cross-hook drain lock (shared with OfflineBanner).
 *   • Listens to `velora:retry-last-failed` so UI retry buttons can
 *     trigger a retry without holding a ref.
 *
 * Extracted from useAssistantChat.ts unchanged. No behavior differences.
 */
export function useOfflineQueueDrain(opts: UseOfflineQueueDrainOptions) {
  // Ref pattern: capture latest callbacks each render so the drain effect
  // (registered once on mount with empty deps) never goes stale on these.
  const appendChatHistoryEntryRef = useRef(opts.appendChatHistoryEntry);
  appendChatHistoryEntryRef.current = opts.appendChatHistoryEntry;
  const setParseErrorRef = useRef(opts.setParseError);
  setParseErrorRef.current = opts.setParseError;

  useEffect(() => {
    if (typeof window === "undefined") return;

    async function drain() {
      if (opts.drainingRef.current) return;
      if (typeof navigator !== "undefined" && navigator.onLine === false) return;
      // Cross-hook lock: only one of {useAssistantChat, OfflineBanner} may
      // drain per cycle. Non-winner bails.
      if (!tryAcquireDrainLock()) return;
      opts.drainingRef.current = true;
      try {
        // Process up to the current queue length; new items enqueued during
        // drain will be handled on the next tick or the next reconnect.
        let safety = 50;
        // Tracks consecutive 429 responses for exponential back-off.
        // Reset to 0 on any non-429 result.
        let backOffRound = 0;
        while (safety-- > 0) {
          const items = getAllOffline();
          if (items.length === 0) break;
          const head: QueuedAction | undefined = items[0];
          if (!head) break;

          // Dead Man's Switch dispatch — sale/stock/cash payloads se
          // drenan via fetch directo a sus endpoints respectivos con el
          // idempotencyKey embebido. El server dedupea via
          // beginIdempotentMutation, así que un retry tras éxito no
          // duplica la operación.
          if (head.type !== "assistant.chat") {
            if (head.attempts >= MAX_REPLAY_ATTEMPTS) {
              popOffline();
              notifyOfflineQueueChanged();
              appendChatHistoryEntryRef.current(
                "error",
                tLang(`Could not send 1 queued ${head.type}. Check it manually.`, `No se pudo enviar 1 ${head.type} en cola. Revisalo manualmente.`),
              );
              continue;
            }
            try {
              // Dispatch without bumping first — we only charge an attempt
              // for non-429 outcomes so rate-limit back-off doesn't eat
              // the attempt budget.
              const result = await dispatchQueuedMutation(head);
              if (result.ok) {
                bumpOfflineAttempts(head);
                popOffline();
                notifyOfflineQueueChanged();
                // Minimum inter-item delay: keeps N queued items from
                // flooding the AI rate limit on reconnect (H12-08).
                await new Promise<void>((r) => setTimeout(r, 300));
                backOffRound = 0;
                continue;
              }
              // 429 — rate limited. Back off without charging an attempt.
              if (result.status === 429) {
                const sleepMs = Math.min(30000, 1000 * 2 ** backOffRound);
                backOffRound += 1;
                await new Promise<void>((r) => setTimeout(r, sleepMs));
                continue;
              }
              // All other outcomes charge an attempt.
              bumpOfflineAttempts(head);
              backOffRound = 0;
              // 401 — session expired while offline. Keep item in queue;
              // stop the drain so we don't burn attempts on every item.
              // Surface a clear, actionable message to the user.
              if (result.status === 401) {
                appendChatHistoryEntryRef.current(
                  "error",
                  tLang(
                    "Your session expired while you were offline. Sign in again and pending items will be sent.",
                    "Tu sesión venció mientras estabas offline. Iniciá sesión de nuevo y los items pendientes se enviarán.",
                  ),
                );
                break;
              }
              // Permanent-failure gate: 404 (resource gone) and 410 (gone)
              // mean the target no longer exists server-side. Retrying would
              // burn attempts forever. Drop the item with a console.warn for
              // diagnostics; the user-facing error chat entry comes from the
              // generic non-retriable branch below.
              if (result.status === 404 || result.status === 410) {
                console.warn(
                  "[offline-queue] dropping queued item — permanent failure",
                  { type: head.type, status: result.status, idempotencyKey: head.idempotencyKey },
                );
                popOffline();
                notifyOfflineQueueChanged();
                appendChatHistoryEntryRef.current(
                  "error",
                  result.errorMessage ?? tLang(`The ${head.type} target no longer exists. Skipped.`, `El destino del ${head.type} ya no existe. Lo salteo.`),
                );
                await new Promise<void>((r) => setTimeout(r, 300));
                continue;
              }
              if (!result.retriable) {
                // 4xx no-retriable — pop con error visible.
                popOffline();
                notifyOfflineQueueChanged();
                appendChatHistoryEntryRef.current(
                  "error",
                  result.errorMessage ?? tLang(`Error processing queued ${head.type}.`, `Error procesando ${head.type} en cola.`),
                );
                await new Promise<void>((r) => setTimeout(r, 300));
                continue;
              }
              // Retriable — quedamos en cola. Marcamos error pero no
              // popeamos.
              markOfflineFailed(head, result.errorMessage ?? "retriable");
              break;
            } catch (err) {
              console.warn("[offline-queue] drain.mutation error:", head.type, err);
              try { markOfflineFailed(head, err instanceof Error ? err.message : String(err)); } catch { /* ignore */ }
              break;
            }
          }

          const payload = head.payload;
          if (!payload?.text) {
            popOffline();
            notifyOfflineQueueChanged();
            continue;
          }

          // Abort drain if the browser dropped connectivity mid-flush.
          if (typeof navigator !== "undefined" && navigator.onLine === false) break;
          // Yield to an active user-initiated request — break now so we
          // don't clobber it. We'll pick up where we left off when the next
          // "online" event fires or the queue-changed notification lands.
          if (opts.inFlightRef.current) break;

          // Per-item attempts cap: if we've already tried MAX_REPLAY_ATTEMPTS
          // times, treat this item as dead and drop it with a user notice.
          if (head.attempts >= MAX_REPLAY_ATTEMPTS) {
            popOffline();
            notifyOfflineQueueChanged();
            try {
              window.dispatchEvent(
                new CustomEvent(CHAT_EVENT.OFFLINE_QUEUE_FAILED, {
                  detail: { item: head },
                })
              );
            } catch {
              /* ignore */
            }
            // Surface a user-facing notice via the existing setParseError
            // feedback channel.
            const deadNotice =
              tLang("Could not send 1 queued message. Check it manually.", "No se pudo enviar 1 mensaje en cola. Revisalo manualmente.");
            appendChatHistoryEntryRef.current("error", deadNotice);
            setParseErrorRef.current(deadNotice);
            continue;
          }

          try {
            // Bump attempts BEFORE the attempt so a crash-loop still
            // increments the counter.
            bumpOfflineAttempts(head);
            await opts.handleGoRef.current(
              payload.text,
              payload.continueAssistantQuestion ?? false,
              head.idempotencyKey
            );
            // Success: pop the head. handleGo is best-effort: even "error"
            // results return normally. If the attempt produced a network
            // error, the browser will be offline on the next loop iteration
            // and we'll bail out at the top.
            popOffline();
            notifyOfflineQueueChanged();
            // Clear the stale parseError only once the queue is fully empty,
            // not after each individual item (avoids flickering the error UI
            // mid-drain when several items are queued).
            if (getAllOffline().length === 0) {
              setParseErrorRef.current(null);
            }
          } catch (err) {
            // Unexpected synchronous failure — record and keep the item for
            // a future retry. Per-item attempts cap will eventually drop it.
            console.error("[offline-queue] drain failure:", err);
            console.warn("[offline-queue] drain error:", err);
            appendChatHistoryEntryRef.current(
              "error",
              tLang("There was an error processing an offline message. I'll retry when you're back online.", "Hubo un error al procesar un mensaje offline. Lo reintentaré cuando vuelvas a estar conectado.")
            );
            try {
              markOfflineFailed(
                head,
                err instanceof Error ? err.message : String(err)
              );
            } catch {
              /* ignore */
            }
            break;
          }
        }
      } finally {
        opts.drainingRef.current = false;
        releaseDrainLock();
      }
    }

    const onOnline = () => {
      void drain();
    };
    window.addEventListener("online", onOnline);
    // Also attempt an initial drain on mount in case we loaded online with
    // leftover items from a prior session.
    if (typeof navigator !== "undefined" && navigator.onLine !== false) {
      void drain();
    }
    return () => {
      window.removeEventListener("online", onOnline);
    };
  }, []);

  // Listen for manual retry requests dispatched by UI components (e.g. a
  // "Reintentar" button in a toast) so they don't need a direct ref.
  //
  // Use a ref to read the current `retryLastFailedAction` so the listener
  // registers exactly once on mount. Reading directly from the deps array
  // would either pin a stale closure (if deps were [], the registered
  // handler would call the very first render's function forever) or thrash
  // the listener on every parent rerender if the callback identity isn't
  // stable. The ref pattern decouples listener identity from the latest
  // closure.
  const retryLastFailedActionRef = useRef(opts.retryLastFailedAction);
  retryLastFailedActionRef.current = opts.retryLastFailedAction;

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handler = () => {
      retryLastFailedActionRef.current();
    };
    window.addEventListener(CHAT_EVENT.RETRY_LAST_FAILED, handler);
    return () => {
      window.removeEventListener(CHAT_EVENT.RETRY_LAST_FAILED, handler);
    };
  }, []);
}
