"use client";

// useAssistantChat.watchdog.ts — watchdog timer factory + error dispatcher.
// Extracted from useAssistantChat.ts to keep that file under the 400-line budget.
//
// The watchdog arms on every request acquire and fires if the response hasn't
// landed within WATCHDOG_TIMEOUT_MS. Each request gets a unique generation
// number so a late-landing response from a prior request can be detected and
// discarded without disrupting the next in-flight request.

import type { MutableRefObject } from "react";
import { releaseInFlight } from "../in-flight-lock";
import { tLang } from "../DashboardLangContext";
import type { ChatEvent } from "../chat-state-machine";

export interface WatchdogArg {
  generation: number;
  requestGenerationRef: MutableRefObject<number>;
  orphanedGenerationRef: MutableRefObject<number>;
  inFlightRef: MutableRefObject<boolean>;
  businessId: string | null;
  watchdogTimeoutMs: number;
  dispatch: (event: ChatEvent) => void;
  setLoadingParse: (v: boolean) => void;
  appendChatHistoryEntry: (kind: "error", text: string) => void;
  setParseError: (text: string | null) => void;
  errorEmittedRef: MutableRefObject<boolean>;
}

/**
 * Arms the watchdog timer for a single request generation.
 * Returns the timer id so the caller can cancel it in the finally block.
 */
export function armWatchdog(arg: WatchdogArg): ReturnType<typeof setTimeout> {
  return setTimeout(() => {
    if (arg.requestGenerationRef.current !== arg.generation) return;
    arg.orphanedGenerationRef.current = arg.generation;
    arg.inFlightRef.current = false;
    arg.dispatch({ type: "watchdog-tripped" });
    if (arg.businessId) releaseInFlight(arg.businessId);
    arg.setLoadingParse(false);
    // Fix #6: pass alsoSetParseError=true so the retry CTA button surfaces
    // in the chat UI. Previously false meant the error entered chat history
    // but parseError stayed null — the retry button never rendered.
    emitErrorOnce(
      arg.errorEmittedRef,
      tLang("The response took too long. Try again.", "La respuesta tardó demasiado. Reintentá."),
      arg.appendChatHistoryEntry,
      true,
      arg.setParseError,
    );
  }, arg.watchdogTimeoutMs);
}

/**
 * Emits an error entry into chat exactly once per request, guarded by
 * `errorEmittedRef` so the watchdog and the response path can't both fire.
 *
 * @param errorEmittedRef  module-level ref that tracks whether this request
 *                         has already emitted an error.
 * @param text             the user-facing error message.
 * @param appendChatHistoryEntry  chat append helper from the hook options.
 * @param alsoSetParseError  whether to also call setParseError (default true).
 * @param setParseError    optional — required when `alsoSetParseError` is true.
 */
export function emitErrorOnce(
  errorEmittedRef: MutableRefObject<boolean>,
  text: string,
  appendChatHistoryEntry: (kind: "error", text: string) => void,
  alsoSetParseError: boolean,
  setParseError?: (text: string | null) => void,
): void {
  if (errorEmittedRef.current) return;
  errorEmittedRef.current = true;
  appendChatHistoryEntry("error", text);
  if (alsoSetParseError && setParseError) setParseError(text);
}
