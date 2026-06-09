"use client";

import { useEffect, useRef } from "react";
import type { ActorRole } from "../contexts";
import type { ChatHistoryEntry } from "../types";

interface UseProactiveWelcomeArgs {
  role: ActorRole;
  loadingPage: boolean;
  chatHistory: ChatHistoryEntry[];
  appendChatHistoryEntry: (kind: ChatHistoryEntry["kind"], text: string) => void;
}

// Fires once per chat mount: asks the server for a greeting, appends it as a
// synthetic "reply" if non-empty. The server gates by role + state:
//   - employee: returns onboarding step or "" if onboarding done
//   - owner: returns T1 greeting if business is empty, "" otherwise
// No LLM turn is consumed — the message is pre-baked text.
export function useProactiveWelcome({
  role,
  loadingPage,
  chatHistory,
  appendChatHistoryEntry,
}: UseProactiveWelcomeArgs) {
  const injectedRef = useRef(false);
  const appendRef = useRef(appendChatHistoryEntry);
  appendRef.current = appendChatHistoryEntry;

  useEffect(() => {
    if (loadingPage) return;
    // Owner T1 greeting is owned by the DB seed in chat-history GET. Skipping
    // the welcome fetch for owner removes any chance of a duplicate greeting,
    // even if a stale cached bundle is parsing the welcome response.
    if (role !== "employee") return;
    if (injectedRef.current) return;
    const hasConversation = chatHistory.some((e) => !e.id.startsWith("trace:"));
    if (hasConversation) { injectedRef.current = true; return; }
    injectedRef.current = true;
    void (async () => {
      try {
        const res = await fetch("/api/business-assistant/welcome");
        if (!res.ok) return;
        const data = await res.json() as { message?: string };
        if (data.message) appendRef.current("reply", data.message);
      } catch { /* silent */ }
    })();
  }, [role, loadingPage, chatHistory]);
}

// Backwards-compat re-export so existing call sites keep compiling. New code
// should import useProactiveWelcome directly.
export const useEmployeeProactiveWelcome = useProactiveWelcome;
