"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { fetchWithTimeout, buildPollingBackoff } from "./utils";
import { buildChatHistoryEntry } from "../chat-history-entry";
import { tLang } from "../DashboardLangContext";
import {
  TRANSIENT_ENTRY_ID_PREFIX,
  SUPPRESSED_TRACE_PATTERNS,
  extractCanonicalBusinessEventKey,
  isObsoleteChatHistoryEntry,
  shouldSkipLocalBusinessHistoryEntry,
  isStaleSaleDraftPrompt,
} from "./chat-history-helpers";
import { TRANSIENT_REPLY_PREFIX } from "../chat-history-entry";
import type { ChatHistoryEntry, ChipsBundle, AgentActivity, WidgetDescriptor } from "../types";
import { parseChipsBundle } from "./chips-parse";

interface UseChatHistoryParams {
  businessId: string | null | undefined;
  persistenceKey: string | null;
}

export function useChatHistory({
  businessId,
  persistenceKey,
}: UseChatHistoryParams) {
  const [chatHistory, setChatHistory] = useState<ChatHistoryEntry[]>([]);
  const [traceLoading, setTraceLoading] = useState(true);
  const [traceError, setTraceError] = useState(false);
  const [historyRefreshToken, setHistoryRefreshToken] = useState(0);
  const [persistRetrySignal, setPersistRetrySignal] = useState(0);

  const durableTraceHydratedForBusinessRef = useRef<string | null>(null);
  const persistedConversationMessageIdsRef = useRef<Set<string>>(new Set());

  // C1: optional `entryId` lets callers pin a specific ID (e.g. the
  // X-Idempotency-Key) so the UI row and the server row share the same
  // clientMessageId. P2002 collapse then fires correctly on the server write.
  // Ref: https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-message-persistence
  const appendChatHistoryEntry = (
    kind: ChatHistoryEntry["kind"],
    text: string,
    chips?: ChipsBundle | null,
    agentActivity?: AgentActivity[],
    entryId?: string,
  ) => {
    if (shouldSkipLocalBusinessHistoryEntry(kind, text)) {
      return;
    }
    // Transient reply bubbles (text prefixed with TRANSIENT_REPLY_PREFIX) must
    // be tagged with a "tmp:"-prefixed id so the persistence loop (which skips
    // ids starting with TRANSIENT_ENTRY_ID_PREFIX = "tmp:") doesn't POST them
    // to /api/chat-history. Without this, the transient bubble gets persisted
    // AND the server-side reply row is persisted separately → two reply rows
    // with the same text but distinct clientMessageIds.
    const isTransientReply =
      kind === "reply" && text.trim().startsWith(TRANSIENT_REPLY_PREFIX);
    const createId = entryId
      ? () => entryId
      : isTransientReply
        ? () => `${TRANSIENT_ENTRY_ID_PREFIX}${crypto.randomUUID()}`
        : undefined;
    const entry = buildChatHistoryEntry({
      kind,
      text,
      chips: chips ?? null,
      ...(createId ? { createId } : {}),
    });
    if (agentActivity && agentActivity.length > 0) {
      entry.agentActivity = agentActivity;
    }
    setChatHistory((prev) => [...prev, entry]);
  };

  // B1: optional `entryId` lets callers pin a specific ID so the UI reply row
  // and the server reply row share the same clientMessageId. Without this,
  // appendDurableChatHistoryEntry generates a fresh crypto.randomUUID() and
  // the server writes a separate row with `{idempotencyKey}-reply` — two
  // different clientMessageId values means P2002 dedup never fires → duplicate.
  const appendDurableChatHistoryEntry = (
    kind: ChatHistoryEntry["kind"],
    text: string,
    chips?: ChipsBundle | null,
    agentActivity?: AgentActivity[],
    entryId?: string,
    widget?: WidgetDescriptor | null,
  ) => {
    const entry = buildChatHistoryEntry({
      kind,
      text,
      chips: chips ?? null,
      widget: widget ?? null,
      ...(entryId ? { createId: () => entryId } : {}),
    });
    if (agentActivity && agentActivity.length > 0) {
      entry.agentActivity = agentActivity;
    }
    setChatHistory((prev) => [...prev, entry]);
  };

  const pendingPersistEntriesRef = useRef<ChatHistoryEntry[]>([]);
  const persistDebounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Retry attempt counter per entry id. Capped at 3; 4xx are non-retriable.
  const persistRetryCountRef = useRef<Map<string, number>>(new Map());

  // Persist conversational chat messages durably (separate from action traces).
  // Entries are collected for 500ms and then flushed sequentially to avoid
  // concurrent POSTs when multiple messages arrive close together.
  useEffect(() => {
    if (!businessId || chatHistory.length === 0) return;

    let hasNew = false;
    for (const entry of chatHistory) {
      if (entry.id.startsWith("trace:")) continue;
      if (entry.id.startsWith("msg:")) {
        persistedConversationMessageIdsRef.current.add(entry.id.slice("msg:".length));
        continue;
      }
      if (entry.id.startsWith(TRANSIENT_ENTRY_ID_PREFIX)) continue;
      if (!["user", "reply", "error", "success"].includes(entry.kind)) continue;
      if (isStaleSaleDraftPrompt(entry)) continue;
      const messageText = entry.text?.trim();
      if (!messageText) continue;
      if (persistedConversationMessageIdsRef.current.has(entry.id)) continue;

      persistedConversationMessageIdsRef.current.add(entry.id);
      pendingPersistEntriesRef.current.push(entry);
      hasNew = true;
    }

    if (!hasNew) return;

    if (persistDebounceTimerRef.current !== null) {
      clearTimeout(persistDebounceTimerRef.current);
    }

    persistDebounceTimerRef.current = setTimeout(() => {
      persistDebounceTimerRef.current = null;
      const batch = pendingPersistEntriesRef.current;
      pendingPersistEntriesRef.current = [];

      // Fix #7: flush all entries in parallel (Promise.allSettled) rather than
      // sequentially. Each entry gets its own 8s timeout so a single slow POST
      // can't block the whole batch. Settled results are inspected for retries.
      // Ref: MDN Promise.allSettled (2026), fetchWithTimeout pattern.
      void Promise.allSettled(
        batch.map(async (entry) => {
          const MAX_PERSIST_RETRIES = 3;
          try {
            const res = await fetchWithTimeout("/api/chat-history", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                clientMessageId: entry.id,
                kind: entry.kind,
                text: entry.text,
                timestamp: entry.timestamp ?? Date.now(),
                ...(entry.chips ? { chips: entry.chips } : {}),
              }),
            }, 8_000);
            if (!res.ok) {
              // 429 is retriable — rate-limited, not a permanent write failure.
              if (res.status === 429) {
                throw new Error(`HTTP 429`);
              }
              // Other 4xx errors are permanent — drop to avoid infinite loop.
              if (res.status >= 400 && res.status < 500) {
                console.warn("[chat-history] permanent persist failure (4xx), dropping entry:", entry.id, res.status);
              } else {
                throw new Error(`HTTP ${res.status}`);
              }
            }
          } catch (err: unknown) {
            const attempts = (persistRetryCountRef.current.get(entry.id) ?? 0) + 1;
            persistRetryCountRef.current.set(entry.id, attempts);
            if (attempts >= MAX_PERSIST_RETRIES) {
              console.warn("[chat-history] max retries reached, dropping entry:", entry.id, err);
              // Leave id in persisted set so we don't try again.
            } else {
              persistedConversationMessageIdsRef.current.delete(entry.id);
              console.warn("[chat-history] persist error, will retry:", entry.id, err);
              // Signal a retry without cloning the chatHistory array (avoids spurious re-renders)
              setPersistRetrySignal((n) => n + 1);
            }
          }
        })
      );
    }, 500);

    return () => {
      if (persistDebounceTimerRef.current !== null) {
        clearTimeout(persistDebounceTimerRef.current);
        persistDebounceTimerRef.current = null;
      }
    };
  }, [businessId, chatHistory, persistRetrySignal]);

  // Hydrate durable conversational messages + durable action traces into chat history.
  // Runs on initial mount (businessId becomes available) and on explicit refresh
  // (historyRefreshToken increments via refreshChatHistory()). lastUpdated and
  // invoiceKey are intentionally excluded — new messages surface via the 3s poll
  // below, so a re-hydrate on every invoice change just races the poll for the
  // same GET (observed: two /api/chat-history requests <10ms apart).
  useEffect(() => {
    if (!businessId) return;
    // When historyRefreshToken changes, the guard is reset before this effect fires
    // so we always re-fetch on an explicit refresh call.
    const refreshKey = `${businessId}:${historyRefreshToken}`;
    if (durableTraceHydratedForBusinessRef.current === refreshKey) return;
    durableTraceHydratedForBusinessRef.current = refreshKey;

    setTraceLoading(true);
    setTraceError(false);
    void (async () => {
      try {
        const [historyRes, traceRes] = await Promise.all([
          fetchWithTimeout("/api/chat-history?limit=50", {}),
          fetchWithTimeout("/api/chat-trace?limit=30", {}),
        ]);

        const historyData = await historyRes.json().catch(() => null) as
          | { messages?: Array<{ id: string; kind: string; source?: string; text: string; chips?: unknown; createdAt?: string }>; clearedAt?: string | null }
          | { error?: string }
          | null;
        const traceData = await traceRes.json().catch(() => null) as
          | { events?: Array<{ id: string; summary: string; createdAt?: string; actionType?: string }> }
          | { error?: string }
          | null;

        if (
          !historyRes.ok ||
          !traceRes.ok ||
          !historyData ||
          !traceData ||
          !("messages" in historyData) ||
          !Array.isArray(historyData.messages) ||
          !("events" in traceData) ||
          !Array.isArray(traceData.events)
        ) {
          setTraceError(true);
          return;
        }

        const durableMessages = historyData.messages
          .filter((message) =>
            typeof message.id === "string" &&
            typeof message.kind === "string" &&
            typeof message.text === "string"
          )
          // Manager (Agent 2) messages — planner nudges + post-payment hop-chats
          // — are included in initial hydration so they appear on first paint
          // instead of waiting one poll cycle (~3s). The id-first dedup at
          // line ~458 (`existingIds.has(entry.id)`) prevents the polling loop
          // from re-inserting the same DB row. The 2-min text-match dedup only
          // fires for `tmp:` / `trace:` prefixed entries, not for DB-backed
          // manager messages — so there's no false-drop risk.
          .map((message) => {
            const chips = parseChipsBundle(message.chips);
            const entry: ChatHistoryEntry = {
              id: message.id,
              kind: message.kind as ChatHistoryEntry["kind"],
              text: message.text,
              timestamp: message.createdAt ? new Date(message.createdAt).getTime() : Date.now(),
              source: (message.source === "system" ? "system" : "assistant") as ChatHistoryEntry["source"],
            };
            if (chips) entry.chips = chips;
            return entry;
          });
        const clearedAt =
          "clearedAt" in historyData && typeof historyData.clearedAt === "string"
            ? new Date(historyData.clearedAt).getTime()
            : null;

        const incomingTraces = traceData.events
          .filter((event) => typeof event.id === "string" && typeof event.summary === "string")
          .filter((event) => {
            if (clearedAt === null) return true;
            const eventTs = event.createdAt ? new Date(event.createdAt).getTime() : Date.now();
            return eventTs > clearedAt;
          })
          // Drop CriticalWriteEvent traces whose corresponding confirmation
          // message is already emitted by useAssistantConfirmation /
          // useStockDraft / etc. Without this filter, formatTraceText
          // renders these traces as user-friendly bubbles ("Listo, agregué
          // el producto X.") on top of the confirmation message — N+1
          // chat entries for one user action.
          //
          // The DB trace stays in CriticalWriteEvent for audit; UI shows
          // only the confirmation. Chat is UX, not audit trail.
          //
          // Sales are NOT in this list because the canonical-key dedup
          // (extractCanonicalBusinessEventKey) handles them: both the
          // sale trace and the chat confirmation carry the invoice
          // number, so they collapse cleanly. The patterns below are
          // ops where the confirmation text doesn't carry the same
          // identifier as the trace, so canonical-key dedup can't fire.
          .filter((event) => !SUPPRESSED_TRACE_PATTERNS.some((re) => re.test(event.summary)))
          .map((event) => ({
            id: `trace:${event.id}`,
            kind: "success" as ChatHistoryEntry["kind"],
            text: event.summary,
            timestamp: event.createdAt ? new Date(event.createdAt).getTime() : Date.now(),
          }));
        const durableEventKeys = new Set(
          durableMessages
            .map((entry) => extractCanonicalBusinessEventKey(entry.text))
            .filter((entry): entry is string => Boolean(entry))
        );
        const durableSuccessEntries = [...durableMessages, ...incomingTraces].filter(
          (entry) => entry.kind === "success"
        );

        for (const message of durableMessages) {
          if (message.id.startsWith("msg:")) {
            persistedConversationMessageIdsRef.current.add(message.id.slice("msg:".length));
          }
        }

        setChatHistory((current) => {
          // Fix #1: id-first dedup — build a Set of all stable server-assigned ids
          // so we never collapse two durable entries that happen to share text but
          // represent distinct intents. Text-match dedup is kept only for local
          // transient entries (tmp:/trace: prefix) which have no server id yet.
          // Ref: Vercel AI SDK chatbot-message-persistence id-dedup pattern (2026).
          const durableIds = new Set([
            ...durableMessages.map((e) => e.id),
            ...incomingTraces.map((e) => e.id),
          ]);

          // Mirror of the poll-path arrivedDurableIds logic: build the set of
          // plain-uuid client ids whose msg:-prefixed durable counterpart is now
          // present in the server snapshot. A plain-uuid optimistic entry "X"
          // must be evicted when "msg:X" is already in durableMessages — without
          // this, both survive the final Map dedup (different keys) and two
          // bubbles flash on hydration/tab-refocus for ~3–8s.
          const arrivedDurableClientIds = new Set(
            durableMessages
              .map((e) => (e.id.startsWith("msg:") ? e.id.slice("msg:".length) : null))
              .filter((id): id is string => id !== null)
          );

          // Carry agentActivity from the evicted optimistic entry to its durable
          // counterpart so the agent-activity bubble survives hydration.
          // Only filled when the optimistic entry actually carries agentActivity.
          const agentActivityCarryover = new Map<string, ChatHistoryEntry["agentActivity"]>();
          for (const entry of current) {
            if (
              !entry.id.startsWith("tmp:") &&
              !entry.id.startsWith("trace:") &&
              !entry.id.startsWith("msg:") &&
              arrivedDurableClientIds.has(entry.id) &&
              entry.agentActivity &&
              entry.agentActivity.length > 0
            ) {
              agentActivityCarryover.set(`msg:${entry.id}`, entry.agentActivity);
            }
          }

          // Apply carryover to durable entries before merge (mutate a local copy).
          const durableMessagesWithCarryover = agentActivityCarryover.size === 0
            ? durableMessages
            : durableMessages.map((e) => {
                const carried = agentActivityCarryover.get(e.id);
                if (carried && !e.agentActivity) {
                  return { ...e, agentActivity: carried };
                }
                return e;
              });

          const transient = current.filter(
            (entry) =>
              !entry.id.startsWith("trace:") &&
              !entry.id.startsWith("msg:") &&
              // Evict plain-uuid optimistic entry when its msg:-prefixed durable
              // counterpart has arrived — durable copy wins. Mirrors poll-path
              // arrivedDurableIds eviction added in commit 6d45dc4b.
              !arrivedDurableClientIds.has(entry.id) &&
              !(
                entry.id.startsWith(TRANSIENT_ENTRY_ID_PREFIX) &&
                entry.kind === "error" &&
                durableSuccessEntries.some((durable) => (durable.timestamp ?? 0) >= (entry.timestamp ?? 0))
              )
          );
          const merged = [...durableMessagesWithCarryover, ...incomingTraces, ...transient]
            .filter((entry) => {
              if (!entry.id.startsWith("msg:")) {
                const canonicalEventKey = extractCanonicalBusinessEventKey(entry.text);
                if (entry.id.startsWith("trace:") && canonicalEventKey && durableEventKeys.has(canonicalEventKey)) {
                  return false;
                }

                // For non-local entries (server-assigned ids): dedup strictly by id.
                // For local transient entries (tmp:/trace: prefix): fall back to
                // text+kind+time-window matching so optimistic UI bubbles collapse
                // correctly when the durable echo arrives.
                const isLocalPrefix =
                  entry.id.startsWith("tmp:") || entry.id.startsWith("trace:");
                if (!isLocalPrefix && durableIds.has(entry.id)) {
                  return !isObsoleteChatHistoryEntry(entry);
                }
                if (!isLocalPrefix) {
                  // Server id not in durable set → new entry, keep it.
                  return !isObsoleteChatHistoryEntry(entry);
                }
                // Local transient: text-match dedup only
                const key = `${entry.kind}|${entry.text.trim().toLowerCase()}`;
                const duplicateWindowMs = 2 * 60 * 1000;
                const matchingDurable = durableMessages.some((durable) =>
                  `${durable.kind}|${durable.text.trim().toLowerCase()}` === key &&
                  Math.abs((durable.timestamp ?? 0) - (entry.timestamp ?? 0)) <= duplicateWindowMs
                );
                if (matchingDurable) return false;
              }
              return !isObsoleteChatHistoryEntry(entry);
            })
            .sort((left, right) => (left.timestamp ?? 0) - (right.timestamp ?? 0));
          const deduped = new Map<string, ChatHistoryEntry>();
          for (const entry of merged) {
            if (!deduped.has(entry.id)) {
              deduped.set(entry.id, entry);
            }
          }
          return Array.from(deduped.values());
        });
      } catch (err) {
        // Fix #10: prefer sendBeacon for best-effort telemetry — fire-and-forget
        // without blocking the tab close path. Falls back to fetch when unavailable.
        // Ref: MDN navigator.sendBeacon (2026).
        {
          const payload = JSON.stringify({
            severity: "WARNING",
            component: "System",
            action: "CHAT_HISTORY_HYDRATE_FAILED",
            a2a_transfer: false,
            message: "useChatHistory: hydration fetch failed",
            data: { error: err instanceof Error ? err.message : String(err) },
          });
          if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
            navigator.sendBeacon("/api/logs", new Blob([payload], { type: "application/json" }));
          } else {
            void fetch("/api/logs", { method: "POST", headers: { "Content-Type": "application/json" }, body: payload });
          }
        }
        setTraceError(true);
      } finally {
        setTraceLoading(false);
      }
    })();
  }, [businessId, historyRefreshToken]);

  // Lightweight poll for server-persisted messages (all sources: manager,
  // assistant, system, owner, employee). Base interval 30s; backs off
  // exponentially with full jitter on 429 (max 60s, cap 5 retries). Resets on 200.
  // Honours Retry-After header when present. No hot-retry on rate-limit.
  useEffect(() => {
    if (!businessId) return;
    let canceled = false;
    let nextTimer: ReturnType<typeof setTimeout> | null = null;
    const backoff = buildPollingBackoff({ baseMs: 2_000, maxMs: 60_000, maxRetries: 5 });
    // 3s lets post-payment hop-chats (procesando → comprobante → envío → tracking)
    // surface as a live step-by-step narration instead of arriving in one delayed
    // batch up to 30s late. Cost: ~10x more DB hits per active chat session, but
    // bounded (single user per business in chat at a time).
    const POLL_INTERVAL_MS = 3_000;

    const scheduleNext = (delayMs: number) => {
      if (canceled) return;
      nextTimer = setTimeout(() => { void pollServerMessages(); }, delayMs);
    };

    const pollServerMessages = async () => {
      if (canceled) return;
      try {
        const res = await fetchWithTimeout("/api/chat-history?limit=50", {});
        if (canceled) return;

        if (res.status === 429) {
          const waitMs = backoff.next(res);
          if (backoff.exhausted) {
            console.warn("[chat-history] manager poll 429 — retries exhausted, holding at max backoff");
          }
          scheduleNext(waitMs);
          return;
        }

        if (!res.ok) { scheduleNext(POLL_INTERVAL_MS); return; }
        backoff.reset();

        const data = await res.json().catch(() => null) as
          | { messages?: Array<{ id: string; kind: string; source?: string; text: string; chips?: unknown; createdAt?: string }> }
          | null;
        if (canceled || !data || !Array.isArray(data.messages)) { scheduleNext(POLL_INTERVAL_MS); return; }

        // Accept all server-persisted sources so Cloud Tasks, cron jobs, A2A
        // push, and curl-driven smoke tests surface within one poll cycle (~30s)
        // without requiring an F5.
        // Canonical pattern: fetch full history on interval, dedup by stable id.
        // Ref: Vercel AI SDK useChat reconciliation — fetch-on-interval + id dedup
        // (https://sdk.vercel.ai/docs/reference/ai-sdk-ui/use-chat, 2025).
        const TRACKED_SOURCES = new Set(["manager", "assistant", "system", "owner", "employee"]);
        const incomingMessages: ChatHistoryEntry[] = data.messages
          .filter((m) =>
            typeof m.source === "string"
            && TRACKED_SOURCES.has(m.source)
            && typeof m.id === "string"
            && typeof m.kind === "string"
            && typeof m.text === "string"
          )
          .map((m) => {
            const chips = parseChipsBundle(m.chips);
            const entry: ChatHistoryEntry = {
              id: m.id,
              kind: m.kind as ChatHistoryEntry["kind"],
              text: m.text,
              timestamp: m.createdAt ? new Date(m.createdAt).getTime() : Date.now(),
              source: m.source as ChatHistoryEntry["source"],
            };
            if (chips) entry.chips = chips;
            return entry;
          });

        // Build the authoritative set of server-persisted message ids returned
        // by this poll cycle. Any msg:-prefixed entry in local state whose id
        // is absent from this set has been soft-resolved server-side (e.g. the
        // ⏳ hop-processing row overwritten with the sentinel) and should be
        // removed from the chat thread.
        const serverMessageIds = new Set(incomingMessages.map((e) => e.id));

        setChatHistory((current) => {
          // Compute fresh entries: server messages not yet in local state.
          // We intentionally do NOT pre-register "msg:X" aliases here so that
          // the durable echo of an optimistic entry ("msg:X") is always
          // considered fresh when the optimistic ("X") is about to be evicted.
          // The alias registration below is only used to short-circuit the
          // fresh-check for non-optimistic duplicates (e.g. server rows that
          // are already in state under their msg: id).
          const existingIds = new Set(current.map((entry) => entry.id));
          // Register msg:-prefixed aliases ONLY for entries that already have
          // a msg:-prefixed copy in state — not for plain-id optimistic entries.
          // This prevents "msg:X" from appearing "already present" when only
          // the plain optimistic "X" exists, which would block the durable from
          // entering `fresh` while the optimistic gets evicted.
          for (const entry of current) {
            if (entry.id.startsWith("msg:")) {
              // Already a durable — also block a re-insert via its plain alias.
              existingIds.add(entry.id.slice("msg:".length));
            }
          }
          const fresh = incomingMessages.filter((entry) => !existingIds.has(entry.id));

          // Evict-and-replace atomicity: build arrivedDurableIds exclusively from
          // the entries that ARE entering state (i.e. in `fresh`). An optimistic
          // "X" is evicted only when its durable "msg:X" is simultaneously being
          // inserted — if "msg:X" was blocked from fresh for any reason, "X" stays.
          // This is the invariant: every logical message renders ≥1 copy at all times.
          const arrivedDurableIds = new Set(
            fresh
              .map((e) => e.id.startsWith("msg:") ? e.id.slice("msg:".length) : null)
              .filter((id): id is string => id !== null)
          );

          // Reconcile removals: drop msg: entries that are no longer returned
          // by the server. Transient (tmp:) and trace: entries are client-only
          // and are never managed by the server, so they are always kept.
          // Also evict optimistic (plain-id) entries whose msg:-prefixed durable
          // counterpart has now arrived in `fresh` — atomic swap: durable in, optimistic out.
          const afterRemoval = current.filter((entry) => {
            if (entry.id.startsWith("msg:")) return serverMessageIds.has(entry.id); // keep if still on server
            if (
              !entry.id.startsWith("tmp:") &&
              !entry.id.startsWith("trace:") &&
              arrivedDurableIds.has(entry.id)
            ) {
              // Optimistic entry superseded by durable server copy in this same update — evict it.
              return false;
            }
            return true;
          });

          const removedCount = current.length - afterRemoval.length;
          if (fresh.length === 0 && removedCount === 0) return current;

          // Log new messages surfaced by poll — useful for debugging
          // server-persisted turns (Cloud Tasks, cron, A2A push, smoke tests).
          if (fresh.length > 0) {
            const countsBySource: Record<string, number> = {};
            for (const e of fresh) {
              const src = e.source ?? "unknown";
              countsBySource[src] = (countsBySource[src] ?? 0) + 1;
            }
            // Fix #10: sendBeacon for poll telemetry — same pattern as hydration catch.
            const payload = JSON.stringify({
              severity: "INFO",
              component: "System",
              action: "CHAT_POLL_NEW_MESSAGES",
              a2a_transfer: false,
              message: "useChatHistory: poll surfaced new messages",
              data: { total: fresh.length, countsBySource },
            });
            if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
              navigator.sendBeacon("/api/logs", new Blob([payload], { type: "application/json" }));
            } else {
              void fetch("/api/logs", { method: "POST", headers: { "Content-Type": "application/json" }, body: payload });
            }
          }

          return [...afterRemoval, ...fresh].sort(
            (left, right) => (left.timestamp ?? 0) - (right.timestamp ?? 0)
          );
        });
        scheduleNext(POLL_INTERVAL_MS);
      } catch (err) {
        // Fix #10: sendBeacon for poll error telemetry.
        {
          const payload = JSON.stringify({
            severity: "WARNING",
            component: "System",
            action: "CHAT_HISTORY_POLL_FAILED",
            a2a_transfer: false,
            message: "useChatHistory: manager poll failed",
            data: { error: err instanceof Error ? err.message : String(err) },
          });
          if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
            navigator.sendBeacon("/api/logs", new Blob([payload], { type: "application/json" }));
          } else {
            void fetch("/api/logs", { method: "POST", headers: { "Content-Type": "application/json" }, body: payload });
          }
        }
        scheduleNext(POLL_INTERVAL_MS);
      }
    };

    // Fix #9: delay the first poll by 5s to avoid a double-fetch on initial
    // mount (hydration effect + poll firing simultaneously). Hydration already
    // loads the latest 50 messages; the poll is redundant until 5s later.
    nextTimer = setTimeout(() => { void pollServerMessages(); }, 5_000);
    return () => {
      canceled = true;
      if (nextTimer !== null) clearTimeout(nextTimer);
    };
  }, [businessId]);

  // Trigger a full re-fetch of chat history from the server. Safe to call from
  // a resume/visibility handler — the guard is embedded in the refreshKey so
  // concurrent calls are deduplicated by the effect's own guard check.
  const refreshChatHistory = useCallback(() => {
    setHistoryRefreshToken((n) => n + 1);
  }, []);

  // Fix #5: refresh when the tab regains focus after being hidden ≥30s.
  // Covers the common mobile pattern: user switches apps, comes back, expects
  // fresh messages. 30s threshold avoids redundant fetches on quick tab switches.
  // Ref: MDN Page Visibility API (2026).
  useEffect(() => {
    if (typeof document === "undefined") return;
    let lastRefreshMs = Date.now();
    const STALE_THRESHOLD_MS = 30_000;
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        const now = Date.now();
        if (now - lastRefreshMs >= STALE_THRESHOLD_MS) {
          lastRefreshMs = now;
          setHistoryRefreshToken((n) => n + 1);
        }
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  const clearDurableChatHistory = useCallback(async (setErrorNotice: (msg: string) => void) => {
    persistedConversationMessageIdsRef.current = new Set();
    // Block hydration with a sentinel — don't null until DELETE completes
    durableTraceHydratedForBusinessRef.current = "__clearing__";
    setChatHistory([]);
    setTraceLoading(false);
    setTraceError(false);

    if (persistenceKey && typeof window !== "undefined") {
      localStorage.removeItem(persistenceKey);
    }

    if (!businessId) {
      return;
    }

    try {
      const res = await fetchWithTimeout("/api/chat-history", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
      });
      const data = await res.json().catch(() => null) as
        | { ok?: boolean; error?: string }
        | null;

      if (!res.ok) {
        throw new Error(data?.error ?? tLang("Could not clear the chat history.", "No se pudo limpiar el historial del chat."));
      }
      // DELETE completed — now allow hydration to re-run with fresh data
      durableTraceHydratedForBusinessRef.current = null;
    } catch (error) {
      durableTraceHydratedForBusinessRef.current = null;
      const errMsg = error instanceof Error ? error.message : tLang("Could not clear the chat history.", "No se pudo limpiar el historial del chat.");
      setErrorNotice(errMsg);
    }
  }, [persistenceKey, businessId]);

  return {
    chatHistory,
    setChatHistory,
    traceLoading,
    // Same signal as traceLoading — exposed under a clearer name so the
    // chat list can render a skeleton state on first paint.
    isLoadingHistory: traceLoading,
    traceError,
    appendChatHistoryEntry,
    appendDurableChatHistoryEntry,
    isStaleSaleDraftPrompt,
    refreshChatHistory,
    clearDurableChatHistory,
  };
}
