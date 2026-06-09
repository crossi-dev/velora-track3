// Formalised chat state machine — replaces the implicit coordination
// between `inFlightRef`, `pendingConfirmation`, `assistantConfirmationSubmitting`,
// `pending-message-queue`, and `offline-queue` in useAssistantChat.
//
// Stub during commit 1: types + reducer signature exist so the fixture
// file can compile, but `handleGo` etc. keep using the legacy refs. The
// real reducer migration happens in commits 7-10.
//
// Not React-coupled: pure reducer. The hook layer wraps it with
// useReducer + side-effect emitters. Tests call the reducer directly.

import type { AssistantConfirmationRequest } from "./types";
import type { AssistantIntent } from "@/app/api/business-assistant/_lib/types";

// ─── States ─────────────────────────────────────────────────────────

export type ChatState =
  | { kind: "idle" }
  | { kind: "processing"; reason: "ai-call" | "command-execute"; startedAt: number; intent?: AssistantIntent }
  | { kind: "pending-confirmation"; request: AssistantConfirmationRequest }
  | { kind: "executing-confirmation"; request: AssistantConfirmationRequest }
  | { kind: "offline" }
  | { kind: "draining-offline" };

// ─── Events ─────────────────────────────────────────────────────────

export type ChatEvent =
  | { type: "submit"; text: string; startedAt?: number }
  | { type: "ai-resolved" }
  | { type: "command-resolved" }
  | { type: "confirmation-requested"; request: AssistantConfirmationRequest }
  | { type: "user-confirmed" }
  | { type: "user-cancelled" }
  | { type: "execution-completed" }
  | { type: "execution-failed"; error: string }
  | { type: "watchdog-tripped" }
  | { type: "online" }
  | { type: "offline" }
  | { type: "drain-completed" };

// ─── Reducer ────────────────────────────────────────────────────────
// Pure function. The hook layer wraps this with useReducer and emits
// side effects (queue, locks, watchdog) in response to state changes.
//
// Design: the reducer holds state ONLY. It does not enqueue messages,
// drain queues, or release locks — those are side effects that the
// caller decides based on `shouldEnqueue(state)` etc. This keeps the
// reducer testable in isolation.

export function chatStateReducer(state: ChatState, event: ChatEvent): ChatState {
  switch (event.type) {
    case "submit": {
      // From idle: transition to processing.
      // From any busy state: caller is expected to enqueue via the
      // pending-message-queue. We don't transition out.
      // startedAt comes from the event payload so the reducer stays a pure
      // function — no side effects, testable in isolation. Falls back to
      // Date.now() only for legacy callers that haven't been updated yet.
      if (state.kind === "idle") {
        return { kind: "processing", reason: "ai-call", startedAt: event.startedAt ?? Date.now() };
      }
      return state;
    }

    case "ai-resolved":
    case "command-resolved": {
      // Work completed. Drop back to idle. Caller is expected to drain
      // the next pending message after seeing this transition.
      if (state.kind === "processing") return { kind: "idle" };
      return state;
    }

    case "confirmation-requested": {
      // Move from processing (or idle, if the command layer dispatched
      // synchronously) into pending-confirmation.
      if (state.kind === "processing" || state.kind === "idle") {
        return { kind: "pending-confirmation", request: event.request };
      }
      return state;
    }

    case "user-confirmed": {
      if (state.kind === "pending-confirmation") {
        return { kind: "executing-confirmation", request: state.request };
      }
      return state;
    }

    case "user-cancelled": {
      if (state.kind === "pending-confirmation") return { kind: "idle" };
      return state;
    }

    case "execution-completed":
    case "execution-failed": {
      if (state.kind === "executing-confirmation") return { kind: "idle" };
      return state;
    }

    case "watchdog-tripped": {
      // Watchdog releases anything that was in-flight. Caller is
      // responsible for emitting the user-visible error.
      if (state.kind === "processing" || state.kind === "executing-confirmation") {
        return { kind: "idle" };
      }
      return state;
    }

    case "offline": {
      // Hard transition: regardless of in-flight work, network is gone.
      // The hook's offline-queue takes ownership of the in-flight item.
      return { kind: "offline" };
    }

    case "online": {
      if (state.kind === "offline") return { kind: "draining-offline" };
      return state;
    }

    case "drain-completed": {
      if (state.kind === "draining-offline") return { kind: "idle" };
      return state;
    }

    default: {
      // Exhaustive check — TS narrows to never if all cases handled.
      // Returning state preserves runtime safety for unknown events.
      const exhaustive: never = event;
      void exhaustive;
      return state;
    }
  }
}

export const INITIAL_CHAT_STATE: ChatState = { kind: "idle" };

// ─── Helpers exposed to tests + the eventual hook wrapper ───────────

export function isBusy(state: ChatState): boolean {
  return state.kind !== "idle" && state.kind !== "offline";
}

export function shouldEnqueue(state: ChatState): boolean {
  return state.kind === "processing"
    || state.kind === "pending-confirmation"
    || state.kind === "executing-confirmation"
    || state.kind === "draining-offline";
}
