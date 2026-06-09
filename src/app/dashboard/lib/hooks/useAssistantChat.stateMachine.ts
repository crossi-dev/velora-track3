"use client";

import { useCallback, useRef, useState } from "react";
import {
  chatStateReducer,
  INITIAL_CHAT_STATE,
  type ChatState,
  type ChatEvent,
} from "../chat-state-machine";

// Synchronous reducer wrapper for useAssistantChat.
//
// useReducer alone defers the new state to the next render — handleGo's
// closure can't see post-dispatch state in the same tick. We mirror state
// into a ref on every dispatch so the same closure can call dispatch()
// then read `chatStateRef.current` immediately, the way it currently
// reads `inFlightRef.current`.
export function useChatState() {
  const chatStateRef = useRef<ChatState>(INITIAL_CHAT_STATE);
  const [chatState, setChatState] = useState<ChatState>(INITIAL_CHAT_STATE);
  const dispatch = useCallback((event: ChatEvent) => {
    const next = chatStateReducer(chatStateRef.current, event);
    if (next === chatStateRef.current) return;
    chatStateRef.current = next;
    setChatState(next);
  }, []);
  return { chatState, chatStateRef, dispatch };
}
