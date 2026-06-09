"use client";

import type { ChatHistoryEntry, ChipsBundle, WidgetDescriptor } from "./types";

export const TRANSIENT_REPLY_PREFIX = "__transient_reply__:";

interface BuildChatHistoryEntryParams {
  kind: ChatHistoryEntry["kind"];
  text: string;
  timestamp?: number;
  createId?: () => string;
  chips?: ChipsBundle | null;
  // Slice-2 generative-UI widget rendered below the bubble. Live-turn only —
  // not persisted (see useChatHistory persistence loop, which omits widget).
  widget?: WidgetDescriptor | null;
}

export function buildChatHistoryEntry({
  kind,
  text,
  timestamp = Date.now(),
  createId = () => crypto.randomUUID(),
  chips,
  widget,
}: BuildChatHistoryEntryParams): ChatHistoryEntry {
  const trimmedInput = text.trim();
  const sanitizedText =
    kind === "reply" && trimmedInput.startsWith(TRANSIENT_REPLY_PREFIX)
      ? trimmedInput.slice(TRANSIENT_REPLY_PREFIX.length).trimStart()
      : text;

  const entry: ChatHistoryEntry = {
    id: createId(),
    kind,
    text: sanitizedText,
    timestamp,
  };
  if (chips) entry.chips = chips;
  if (widget) entry.widget = widget;
  return entry;
}
