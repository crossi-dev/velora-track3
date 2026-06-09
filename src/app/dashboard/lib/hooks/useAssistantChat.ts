"use client";

import { useRef, useCallback, useEffect } from "react";
import { acquireInFlight, isInFlight, releaseInFlight } from "../in-flight-lock";
import { enqueuePendingMessage, drainNextPendingMessage, clearPendingMessages, registerPendingMessageDrainer } from "../pending-message-queue";
import { classifyErrorForUser } from "./useAssistantChat.errors";
import { useOfflineQueueDrain } from "./useOfflineQueueDrain";
import { useRetrySaleListener } from "./useRetrySaleListener";
import { useAssistantChatSubHooks } from "./useAssistantChat.subhooks";
import { publishIdempotencyKey, safeNewUuid } from "./useAssistantChat.idempotency-keys";
import { useChatState } from "./useAssistantChat.stateMachine";
import { tryPreAIDispatch } from "./useAssistantChat.preAIDispatch";
import type { UseAssistantChatOptions } from "./useAssistantChat.types";
import { tLang } from "../DashboardLangContext";
import { armWatchdog, emitErrorOnce } from "./useAssistantChat.watchdog";
import { dispatchClassifiedError } from "./useAssistantChat.errorDispatch";
import { handleOfflineGuard } from "./useAssistantChat.offlineGuard";

export type { UseAssistantChatOptions };

// Max round-trip before the watchdog force-releases the in-flight lock.
// 90s must exceed the server-side cap (LLM_TIMEOUT_MS=80s on Cloud Run) +
// PAYMENT_LINK_FAST_PATH_TIMEOUT_MS=55s with headroom. Previous 45s value
// was a regression: if the Payments Agent legitimately took 50s (Gemini Pro
// thinking + MP API + Andreani quote), the client gave up at 45s and showed
// an error while the link was still being created. p95 deterministic paths
// are still <5s; this only affects the long-tail Payments fast-path.
// Ref: https://cloud.google.com/architecture/reliability/retry-patterns#timeouts
const WATCHDOG_TIMEOUT_MS = 90_000;

export function useAssistantChat(opts: UseAssistantChatOptions) {
  // Reducer-backed chat state; commits 8-11 progressively migrate refs onto
  // it. Today only `dispatch` is wired — `chatStateRef` is consumed by
  // commit 11 when the legacy refs come out.
  const { dispatch } = useChatState();
  // Synchronous double-submit guard. `loadingParse` only flips on the next
  // render; this ref blocks the second call within the same tick.
  const inFlightRef = useRef(false);
  // Last input that failed with a network error — exposed via
  // `retryLastFailedAction` so the UI can offer a "Reintentar" button. We
  // also track the idempotency key used on the failed attempt so the retry
  // reuses it and the server dedupes any partial success.
  const lastFailedInputRef = useRef<{ text: string; idempotencyKey: string } | null>(null);
  // Guards against overlapping drain cycles (same-tab).
  const drainingRef = useRef(false);
  // Watchdog: force-releases in-flight if a request hangs past WATCHDOG_TIMEOUT_MS.
  // requestGenerationRef increments per acquire so a fired watchdog only orphans
  // its own generation if a fresh request is already running.
  const watchdogTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestGenerationRef = useRef(0);
  const orphanedGenerationRef = useRef(-1);
  // Watchdog vs request-flow can both emit an error when the response lands
  // within ~1 event-loop tick of the 15s timeout. First write wins.
  const errorEmittedRef = useRef(false);
  // AbortController for the current in-flight fetch (user-cancel or watchdog).
  const abortControllerRef = useRef<AbortController | null>(null);
  // Last text dispatched while a request was in-flight, used to drop
  // double-fire of the SAME text (mobile touchend+click race, fast double
  // taps on chips) without breaking legitimate enqueue of a DIFFERENT text.
  const lastSubmittedTextRef = useRef<string | null>(null);

  const { resolveInput, executeAction, handleFallbackReply, sendPurchaseRequestToSupplier } =
    useAssistantChatSubHooks(opts);

  async function handleGo(
    submittedText?: string,
    continueAssistantQuestion = false,
    replayKey?: string
  ) {
    // ── Confirmation short-circuit ────────────────────────────────────
    // Runs BEFORE the in-flight queue check so a confirmation card being
    // open + a non-affirmation message produces a warning, not an enqueue.
    if (opts.assistantConfirmationRequest) {
      const pendingText = (submittedText ?? opts.input).trim();
      if (pendingText) {
        const { isShortConfirmation, isShortCancellation } =
          await import("./confirmation-intent");
        if (isShortConfirmation(pendingText)) {
          opts.appendChatHistoryEntry("user", pendingText);
          opts.setInput("");
          void opts.onConfirmationConfirm();
          return;
        }
        if (isShortCancellation(pendingText)) {
          opts.appendChatHistoryEntry("user", pendingText);
          opts.setInput("");
          opts.onConfirmationCancel();
          return;
        }
        // Card is open and the message is neither affirmation nor
        // cancellation — block to prevent orphaning the pending card.
        // Do NOT enqueue: the user's intent is unclear with a card open.
        opts.appendChatHistoryEntry(
          "reply",
          tLang("There's a pending confirmation. Confirm or cancel before continuing.", "Hay una confirmación pendiente. Confirmá o cancelá antes de continuar.")
        );
        return;
      }
    }

    // ── In-flight queue ───────────────────────────────────────────────
    // Previous behavior dropped messages that arrived while a request was
    // still processing. Now they go to the tail of pendingQueueRef and
    // get drained one-by-one in the finally block. Echo into chat so the
    // user sees the message was captured.
    if (inFlightRef.current) {
      const enqueueText = (submittedText ?? opts.input).trim();
      // Drop double-fire of the SAME text (mobile touchend+click race,
      // fast double tap on send button or chip) — otherwise it produces
      // two user bubbles with distinct UUIDs (e.g. msg:bd7aec6c + msg:05b9034b
      // for the same text) and the chat-history persist effect POSTs both.
      // Canonical 2026 pattern (Vercel AI SDK chatbot-message-persistence):
      // one stable id per user action. Different-text enqueue still works.
      if (enqueueText && enqueueText === lastSubmittedTextRef.current) {
        return;
      }
      if (enqueueText) {
        enqueuePendingMessage(enqueueText);
        opts.appendChatHistoryEntry("user", enqueueText);
        opts.setInput("");
      }
      return;
    }
    if (opts.loadingParse) return;
    // Cross-hook lock held (e.g. confirmation flow). Enqueue so its
    // release path can drain — previously this dropped silently.
    if (isInFlight(opts.businessId)) {
      const enqueueText = (submittedText ?? opts.input).trim();
      if (enqueueText) {
        enqueuePendingMessage(enqueueText);
        opts.appendChatHistoryEntry("user", enqueueText);
        opts.setInput("");
      }
      return;
    }

    // ── Offline short-circuit ─────────────────────────────────────────
    // If the browser reports offline, enqueue the action and surface a
    // user-facing notice instead of attempting the fetch. The queue drains
    // automatically when connectivity returns.
    const candidateText = submittedText ?? opts.input;
    if (handleOfflineGuard({
      businessId: opts.businessId,
      candidateText,
      continueAssistantQuestion,
      replayKey,
      appendChatHistoryEntry: opts.appendChatHistoryEntry,
      setInput: opts.setInput,
    })) return;

    // Generate (or reuse) the idempotency key for this attempt and publish
    // it so the fetch layer can attach the header.
    const idempotencyKey = replayKey ?? safeNewUuid();
    publishIdempotencyKey(idempotencyKey);

    if (!acquireInFlight(opts.businessId)) return;
    inFlightRef.current = true;
    lastSubmittedTextRef.current = (submittedText ?? opts.input).trim() || null;
    dispatch({ type: "submit", text: submittedText ?? opts.input });
    errorEmittedRef.current = false;
    // Arm the watchdog. Each acquire bumps the generation so a late-
    // arriving response from a prior (orphaned) request can be detected
    // and dropped.
    const generation = ++requestGenerationRef.current;
    const boundEmitErrorOnce = (text: string, alsoSetParseError = true) =>
      emitErrorOnce(errorEmittedRef, text, opts.appendChatHistoryEntry, alsoSetParseError, opts.setParseError);
    watchdogTimerRef.current = armWatchdog({
      generation,
      requestGenerationRef,
      orphanedGenerationRef,
      inFlightRef,
      businessId: opts.businessId,
      watchdogTimeoutMs: WATCHDOG_TIMEOUT_MS,
      dispatch,
      setLoadingParse: opts.setLoadingParse,
      appendChatHistoryEntry: opts.appendChatHistoryEntry,
      setParseError: opts.setParseError,
      errorEmittedRef,
    });
    // Arm the per-request AbortController so the user can cancel mid-flight.
    const abortController = new AbortController();
    abortControllerRef.current = abortController;
    try {
      // Deterministic short-circuit antes de tocar la IA — parser de
      // comandos + clarificación de inputs incompletos. Implementación
      // en useAssistantChat.preAIDispatch.ts.
      const rawTextForParser = (submittedText ?? opts.input).trim();
      if (rawTextForParser && (await tryPreAIDispatch(rawTextForParser, opts))) {
        return;
      }

      let result: Awaited<ReturnType<typeof resolveInput>>;
      try {
        result = await resolveInput(submittedText, continueAssistantQuestion, abortController.signal);
      } catch (fetchError) {
        // Distinguish internal fetch timeout (reason === "timeout", set by
        // fetchWithTimeout's setTimeout) from a user-initiated cancel (reason
        // is undefined). Both throw DOMException name "AbortError".
        if (fetchError instanceof DOMException && fetchError.name === "AbortError") {
          const isInternalTimeout =
            (fetchError as DOMException & { reason?: unknown }).reason === "timeout" ||
            // Fallback: check the AbortSignal reason directly if available
            (abortController.signal.reason === "timeout");
          opts.appendChatHistoryEntry(
            "error",
            isInternalTimeout
              ? tLang(
                  "The response took too long. Please try again.",
                  "La respuesta tardó demasiado. Por favor, intentá de nuevo."
                )
              : tLang("Cancelled — you can try again.", "Cancelado — podés intentar de nuevo.")
          );
          return;
        }
        throw fetchError;
      }

      // Watchdog already fired for this generation — drop the late response
      // instead of mixing it into the user's next interaction.
      if (orphanedGenerationRef.current === generation) return;

      if (result.kind === "clear") {
        // User cleared chat — drop any queued messages so they don't
        // resurface in the freshly cleared thread.
        clearPendingMessages();
        return "CLEAR_CHAT";
      }
      if (result.kind === "handled_locally") return;

      if (result.kind === "error") {
        const classified = classifyErrorForUser(result.message, undefined, opts.t);
        dispatchClassifiedError(classified, result.message, {
          businessId: opts.businessId,
          candidateText,
          continueAssistantQuestion,
          idempotencyKey,
          lastFailedInputRef,
          boundEmitErrorOnce,
        });
        return;
      }

      // Success — clear any stale retry target.
      lastFailedInputRef.current = null;

      // result.kind === "needs_action"
      const { parsed, rawInput } = result;

      try {
        // Dispatch every action in the flat array. Each one runs independently
        // with its own try/catch and feedback. A failure on one does NOT
        // prevent subsequent actions from executing.
        let anyHandled = false;
        for (const action of parsed.actions) {
          try {
            const handled = await executeAction(action, parsed, rawInput);
            if (handled) anyHandled = true;
          } catch (actionError) {
            console.error("[assistant] action failed", action.type, actionError);
            opts.appendChatHistoryEntry(
              "error",
              tLang(`Could not apply the action "${action.type}". Check manually.`, `No se pudo aplicar la acción "${action.type}". Revisá manualmente.`)
            );
          }
        }
        if (!anyHandled) {
          handleFallbackReply(parsed);
        }
      } catch (error) {
        const errMsg =
          error instanceof Error
            ? error.message
            : tLang("Could not process the request.", "No se pudo procesar la solicitud.");
        const classified = classifyErrorForUser(errMsg, undefined, opts.t);
        const failed = candidateText?.trim() || null;
        if (classified.canRetry && failed) {
          lastFailedInputRef.current = { text: failed, idempotencyKey };
        }
        boundEmitErrorOnce(classified.message);
      }
    } finally {
      // Clear the abort controller ref once the request settles (success,
      // error, cancel, or watchdog) so stale refs can't fire on the next turn.
      abortControllerRef.current = null;
      if (watchdogTimerRef.current !== null) {
        clearTimeout(watchdogTimerRef.current);
        watchdogTimerRef.current = null;
      }
      // Watchdog already released the locks and surfaced a timeout — don't
      // double-toggle loadingParse or release twice.
      if (orphanedGenerationRef.current !== generation) {
        opts.setLoadingParse(false);
        inFlightRef.current = false;
        lastSubmittedTextRef.current = null;
        dispatch({ type: "ai-resolved" });
        releaseInFlight(opts.businessId);
      }
      // Drain the next queued message if any. Defer to the next tick so
      // React state from this request settles first; the queued submission
      // sees clean lock state and proceeds as a fresh request.
      drainNextPendingMessage();
    }
  }

  // Hold the latest `handleGo` in a ref so the drain effect (empty deps)
  // always calls the current-render closure instead of a stale one captured
  // on first mount.
  const handleGoRef = useRef(handleGo);
  handleGoRef.current = handleGo;

  // Drain handler registered for cross-hook callers (e.g. confirmation finally).
  useEffect(() => registerPendingMessageDrainer((text) => {
    void handleGoRef.current(text, false);
  }), []);

  const retryLastFailedAction = useCallback((): boolean => {
    const failed = lastFailedInputRef.current;
    if (!failed) return false;
    lastFailedInputRef.current = null;
    // Reuse the idempotency key so the server dedupes if the original
    // request actually landed.
    void handleGoRef.current(failed.text, false, failed.idempotencyKey);
    return true;
  }, []);

  useOfflineQueueDrain({
    handleGoRef,
    inFlightRef,
    drainingRef,
    appendChatHistoryEntry: opts.appendChatHistoryEntry,
    setParseError: opts.setParseError,
    retryLastFailedAction,
  });

  useRetrySaleListener(handleGoRef);

  const abortCurrentRequest = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
  }, []);

  return {
    handleGo,
    sendPurchaseRequestToSupplier,
    retryLastFailedAction,
    abortCurrentRequest,
  };
}
