"use client";

import React, { useState, useRef, useEffect, useMemo } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { CaretDown } from "@phosphor-icons/react";
import type { ChatHistoryEntry, MissingFieldHint } from "../../lib/types";
import { CHAT_EVENT } from "../../lib/chat-events";
import { ThinkingIndicator } from "../ThinkingIndicator";
import { ChatRow } from "./ChatRow";
import { Button } from "@/components/ui/button";

const TRACE_STATUS_STYLE: React.CSSProperties = {
  textAlign: "center",
  padding: "0.5rem 0",
  opacity: 0.7,
};

const INLINE_ERROR_STYLE: React.CSSProperties = {
  lineHeight: 1.7,
  whiteSpace: "pre-wrap",
  color: "var(--danger)",
};

interface AssistantHistoryProps {
  chatHistory: ChatHistoryEntry[];
  traceLoading?: boolean;
  traceError?: boolean;
  hasResponse: boolean;
  loadingParse: boolean;
  parseError: string | null;
  parseMissingField: MissingFieldHint | null;
  quickActionError: string | null;
  handleGo: (text?: string, continueAssistantQuestion?: boolean) => void;
  handleMissingFieldSubmit: (value: string) => void;
  t: (en: string, es: string) => string;
  setInput: (value: string) => void;
  pendingInputRef: React.MutableRefObject<string>;
  chatThreadBottomRef: React.RefObject<HTMLDivElement | null>;
  onScroll?: (e: React.UIEvent<HTMLDivElement>) => void;
  /** Suppress the decorative Velora mark in the empty state. Set when a
   *  SetupChecklist is rendered above the chat to avoid an orphaned logo. */
  hideEmptyMark?: boolean;
}

// Auto-capacitación del empleado (Track 3 demo). Cuatro categorías visibles
// — el empleado nuevo identifica de un vistazo qué puede hacer con Velora:
// vender, cargar stock, consultar ventas, consultar inventario.
//

// eslint-disable-next-line max-lines-per-function -- composition root, not a logic violation
export function AssistantHistory({
  chatHistory,
  traceLoading = false,
  traceError = false,
  hasResponse,
  loadingParse,
  parseError,
  parseMissingField,
  quickActionError,
  handleGo,
  handleMissingFieldSubmit,
  t,
  setInput,
  chatThreadBottomRef,
  onScroll,
  hideEmptyMark = false,
}: AssistantHistoryProps) {
  const [missingFieldValue, setMissingFieldValue] = useState("");
  const [showScrollFab, setShowScrollFab] = useState(false);
  const [networkRetryVisible, setNetworkRetryVisible] = useState(false);
  // Guard autoFocus on price input: only on non-touch / wider viewports.
  // Matches the same pattern used in AssistantInputBar (window.innerWidth >= 768).
  // SSR-safe: starts false, flips after mount to avoid hydration mismatch.
  const [isWideViewport, setIsWideViewport] = useState(false);
  useEffect(() => {
    setIsWideViewport(typeof window !== "undefined" && window.innerWidth >= 768);
  }, []);

  // Single aria-live region — announces only newly-arrived assistant/manager
  // messages so screen readers hear new AI replies without re-announcing every
  // historical message that scrolls into view (which per-row aria-live caused).
  const [liveText, setLiveText] = useState("");
  // Initialize to the latest existing entry's id so that on first mount with
  // pre-loaded history we do NOT announce the already-visible last message —
  // only genuinely new arrivals (id changes after mount) trigger a read-out.
  const lastAnnouncedIdRef = useRef<string | undefined>(
    (() => {
      for (let i = chatHistory.length - 1; i >= 0; i--) {
        const e = chatHistory[i];
        if (e.kind !== "user" && e.kind !== "success") return e.id;
      }
      return undefined;
    })()
  );

  // Derive the latest non-user entry from the history array without iterating
  // inside an effect — useMemo is sufficient and avoids a double-render.
  // Restrict to actual assistant replies and errors; exclude "success" kind
  // because those are handled by ActivityRow and would double-announce.
  const latestAssistantEntry = useMemo(() => {
    for (let i = chatHistory.length - 1; i >= 0; i--) {
      const e = chatHistory[i];
      if (e.kind !== "user" && e.kind !== "success") return e;
    }
    return undefined;
  }, [chatHistory]);

  useEffect(() => {
    if (!latestAssistantEntry) return;
    if (latestAssistantEntry.id === lastAnnouncedIdRef.current) return;
    lastAnnouncedIdRef.current = latestAssistantEntry.id;
    setLiveText(latestAssistantEntry.text);
  }, [latestAssistantEntry]);

  // Listen for network errors dispatched by useAssistantChat and show a retry
  // banner when canRetry is true. The banner is dismissed on retry or on the
  // next successful message (loadingParse going true → false).
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ canRetry: boolean }>).detail;
      if (detail?.canRetry) setNetworkRetryVisible(true);
    };
    window.addEventListener(CHAT_EVENT.NETWORK_ERROR, handler);
    return () => window.removeEventListener(CHAT_EVENT.NETWORK_ERROR, handler);
  }, []);

  // Auto-dismiss the retry banner when a new send starts (loadingParse flips true).
  useEffect(() => {
    if (loadingParse) setNetworkRetryVisible(false);
  }, [loadingParse]);

  const handleNetworkRetry = () => {
    setNetworkRetryVisible(false);
    window.dispatchEvent(new Event(CHAT_EVENT.RETRY_LAST_FAILED));
  };

  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // estimateSize: 140px matches the average real bubble height (short reply ≈80px,
  // multi-line ≈160px, cards ≈240px). A closer estimate means the initial
  // scrollToIndex (on chatHistory.length change) already lands near the true
  // bottom — measureElement fine-tunes from there without triggering extra scrolls.
  // overscan: 8 keeps rows pre-measured above the viewport so height surprises
  // happen off-screen rather than in the visible area.
  const chatVirtualizer = useVirtualizer({
    count: chatHistory.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => 140,
    overscan: 8,
    measureElement: (el) => el.getBoundingClientRect().height,
  });

  // WhatsApp-style scroll: only auto-scroll to bottom if the user is already
  // near the bottom OR it's the first render. Uses virtualizer.scrollToIndex
  // because items are absolutely positioned — scrollIntoView on a sentinel
  // div doesn't work with TanStack Virtualizer.
  const NEAR_BOTTOM_PX = 120;
  const prevChatLengthRef = useRef(0);
  const wasAtBottomRef = useRef(true);
  const chatLengthRef = useRef(chatHistory.length);
  chatLengthRef.current = chatHistory.length;

  useEffect(() => {
    if (chatHistory.length === 0) return;
    if (chatHistory.length === prevChatLengthRef.current) return;

    const isInitialMount = prevChatLengthRef.current === 0;
    // Use wasAtBottomRef (updated on every scroll event) rather than re-reading
    // the DOM here. The DOM read is unreliable at effect-fire time: the virtualizer
    // has not yet painted the new row so scrollHeight hasn't grown yet, making
    // distanceFromBottom artificially small — the user appears "near bottom" even
    // when they've scrolled up to read history. wasAtBottomRef reflects the true
    // position continuously and is the canonical signal for stick-to-bottom.
    const userIsNearBottom = isInitialMount || wasAtBottomRef.current;

    prevChatLengthRef.current = chatHistory.length;
    if (!userIsNearBottom) return;

    // First pass: virtualizer positions based on estimateSize (140px) before
    // measureElement has run on the new item.
    chatVirtualizer.scrollToIndex(chatHistory.length - 1, { align: "end" });

    // Second pass (double-RAF): after the browser has painted and measureElement
    // has corrected the real item height, re-anchor to the true bottom.
    // This closes the gap when the real bubble height differs from 140px
    // (short replies ≈80px, cards ≈240px), which would otherwise leave the
    // viewport stranded mid-thread.
    const raf1 = requestAnimationFrame(() => {
      const raf2 = requestAnimationFrame(() => {
        chatVirtualizer.scrollToIndex(chatLengthRef.current - 1, { align: "end" });
      });
      return raf2;
    });
    return () => cancelAnimationFrame(raf1);
  }, [chatHistory.length, chatVirtualizer]);

  // Track whether the user is parked at (or near) the bottom so the resize
  // observer below knows whether to re-pin after a height change.
  // Also drives the scroll-to-bottom FAB visibility.
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const update = () => {
      const atBottom =
        el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
      wasAtBottomRef.current = atBottom;
      setShowScrollFab(!atBottom);
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    return () => el.removeEventListener("scroll", update);
  }, []);

  // When the scroll container shrinks (textarea grows on type, mobile keyboard
  // opens, secondary panel mounts), the last bubble disappears off-screen
  // because scrollTop stays put while clientHeight drops. Re-pin to bottom if
  // the user was reading the bottom of the thread.
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let rafId: number | undefined;
    const ro = new ResizeObserver(() => {
      if (wasAtBottomRef.current && chatLengthRef.current > 0) {
        // Cancel any pending re-pin from a previous resize burst (e.g. textarea
        // growing one px per keystroke) before scheduling a new one. This
        // debounces the scrollToIndex call to the final settled size so the
        // virtualizer doesn't thrash on rapid height changes.
        if (rafId !== undefined) cancelAnimationFrame(rafId);
        rafId = requestAnimationFrame(() => {
          rafId = undefined;
          chatVirtualizer.scrollToIndex(chatLengthRef.current - 1, { align: "end" });
        });
      }
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      if (rafId !== undefined) cancelAnimationFrame(rafId);
    };
  }, [chatVirtualizer]);

  // NOTE: Do NOT add a totalSize-watching effect that calls scrollToIndex.
  // TanStack Virtualizer with measureElement fires one measurement per row
  // as it renders, which means N rows = N totalSize changes = N scrollToIndex
  // calls in rapid succession. That produces the "messages collapsing" flicker.
  // The chatHistory.length effect above is the only scroll-to-bottom trigger
  // needed — the virtualizer handles position recalculation internally.

  return (
    <div style={{ position: "relative", minHeight: 0, display: "flex", flexDirection: "column", flex: 1 }}>
    {/* Dedicated aria-live region — announces only newly-arrived AI messages.
        Visually hidden but readable by screen readers. One region per thread
        prevents re-announcement of history as items scroll into the virtualizer. */}
    <div
      aria-live="polite"
      aria-atomic="true"
      style={{ position: "absolute", width: "1px", height: "1px", overflow: "hidden", clipPath: "inset(50%)", whiteSpace: "nowrap" }}
    >
      {liveText}
    </div>
    <div
      ref={scrollContainerRef}
      role="log"
      aria-label={t("Chat thread", "Hilo del chat")}
      className="assistant-thread-scroll"
      style={{
        minHeight: 0,
        flex: 1,
        overflowY: "auto",
        maskImage: "linear-gradient(to bottom, transparent 0, black 16px, black calc(100% - 8px), transparent 100%)",
        WebkitMaskImage: "linear-gradient(to bottom, transparent 0, black 16px, black calc(100% - 8px), transparent 100%)",
      }}
      onScroll={onScroll}
    >
      <div className={`assistant-thread-column assistant-thread-feed flex min-h-full w-full flex-col px-4 ${hasResponse ? "gap-2.5 py-3.5" : "py-1.5"}`}>
        {!hasResponse && (
          <div className="flex flex-1 flex-col gap-3" style={{ justifyContent: "flex-end", paddingBottom: "clamp(80px, 20dvh, 160px)" }}>
            {!hideEmptyMark && (
              <img src="/velora-mark.svg" alt="" aria-hidden width={48} height={48} className="velora-mark-breathe" style={{ opacity: 1, width: 48, height: 48, alignSelf: "center", marginBottom: "0.25rem" }} />
            )}
            {/* Greeting bubble + suggestion chips are intentionally hidden
                while the chat history is still being fetched on first paint.
                Without this guard, fresh-onboarding owners (no chat history
                yet) saw the established-user empty state ("¿Qué querés
                hacer hoy?" + 4 action chips) for ~1s before the onboarding
                welcome arrived — a confusing flash audited 2026-05-24. The
                breathing Velora mark above stays as a loading indicator. */}
            {!traceLoading && (
            <>
            {/* Canonical 2026: assistant bubbles omit avatar — sender is conveyed
                by alignment + tone. See ChatRow.tsx note. */}
            <div className="flex justify-start">
              <div
                className="rounded-2xl rounded-tl-sm px-4 py-3"
                style={{
                  backgroundColor: "var(--surface-raised, var(--surface))",
                  border: "1px solid var(--border)",
                  maxWidth: "85%",
                }}
              >
                <p style={{ fontSize: "1rem", lineHeight: 1.5, color: "var(--tone-strong)", margin: 0 }}>
                  {t(
                    "Hi! I'm Velora. What would you like to do today?",
                    "¡Hola! Soy Velora. ¿Qué querés hacer hoy?"
                  )}
                </p>
              </div>
            </div>
            {/* Default suggestion chips removed 2026-05-26 — direct free-text input only. */}
            </>
            )}
          </div>
        )}

        {hasResponse && (
          <div className="flex flex-col gap-2.5">
            {traceLoading && chatHistory.length === 0 && (
              <div className="flex flex-col gap-2.5" aria-label={t("Loading history", "Cargando historial")}>
                {[0, 1, 2].map((i) => (
                  <div
                    key={i}
                    aria-hidden="true"
                    className={i % 2 === 0 ? "rounded-2xl rounded-tl-sm" : "rounded-2xl rounded-tr-sm"}
                    style={{
                      alignSelf: i % 2 === 0 ? "flex-start" : "flex-end",
                      width: i === 1 ? "55%" : "70%",
                      height: "2.5rem",
                      backgroundColor: "var(--surface-subtle)",
                      opacity: 0.6,
                    }}
                  />
                ))}
              </div>
            )}
            {traceError && !traceLoading && chatHistory.length === 0 && (
              <p className="text-caption" style={TRACE_STATUS_STYLE}>
                {t("Could not load history", "No se pudo cargar el historial")}
              </p>
            )}
            <div role="list" style={{ height: `${chatVirtualizer.getTotalSize()}px`, position: "relative" }}>
              {chatVirtualizer.getVirtualItems().map((virtualRow) => {
                const entry = chatHistory[virtualRow.index];
                const prevEntry = virtualRow.index > 0 ? chatHistory[virtualRow.index - 1] : null;
                // Only show a divider when both entries have timestamps and belong to different calendar days.
                // Without the undefined guard, a missing prevEntry.timestamp falls back to epoch 0,
                // causing a spurious divider on every message without a timestamp.
                const showDateDivider = !prevEntry
                  ? entry.timestamp !== undefined
                  : entry.timestamp !== undefined &&
                    prevEntry.timestamp !== undefined &&
                    new Date(entry.timestamp).toDateString() !== new Date(prevEntry.timestamp).toDateString();
                return (
                  <div
                    key={entry.id}
                    role="listitem"
                    ref={chatVirtualizer.measureElement}
                    data-index={virtualRow.index}
                    style={{
                      position: "absolute",
                      top: 0,
                      left: 0,
                      width: "100%",
                      transform: `translateY(${virtualRow.start}px)`,
                      paddingBottom: "10px",
                    }}
                  >
                    <ChatRow
                      entry={entry}
                      showDateDivider={showDateDivider}
                      onSuggest={setInput}
                      onSendChip={(text) => handleGo(text, false)}
                      loadingParse={loadingParse}
                    />
                  </div>
                );
              })}
            </div>

            {loadingParse && <ThinkingIndicator />}

            {parseMissingField?.type === "price" && (
              <div className="flex justify-start">
              <div
                  className="w-full max-w-[85%] rounded-2xl rounded-tl-sm p-4"
                  style={{ backgroundColor: "transparent" }}
                >
                  <p className="text-caption" style={{ color: "var(--tone-strong)", marginBottom: "0.75rem", lineHeight: 1.6 }}>
                    {t(
                      `To record the sale of "${parseMissingField.productName}" I need the unit price.`,
                      `Para registrar la venta de "${parseMissingField.productName}" necesito el precio unitario.`
                    )}
                  </p>
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (!missingFieldValue) return;
                      handleMissingFieldSubmit(missingFieldValue);
                      setMissingFieldValue("");
                    }}
                    className="flex gap-2"
                  >
                    <div className="relative flex-1">
                      <span style={{ position: "absolute", left: "0.6rem", top: "50%", transform: "translateY(-50%)", color: "var(--tone-muted)", fontSize: "0.875rem", pointerEvents: "none", userSelect: "none" }}>$</span>
                      <input
                        type="number"
                        inputMode="decimal"
                        step="0.01"
                        min="0.01"
                        autoFocus={isWideViewport}
                        value={missingFieldValue}
                        onChange={(e) => setMissingFieldValue(e.target.value)}
                        placeholder={t("E.g.: 1500", "Ej: 1500")}
                        className="flex-1 rounded-token-md px-3 py-2 outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand)] text-caption"
                        style={{
                          color: "var(--tone-strong)",
                           backgroundColor: "transparent",
                          minHeight: "44px",
                          width: "100%",
                          paddingLeft: "1.5rem",
                        }}
                      />
                    </div>
                    <Button
                      type="submit"
                      disabled={!missingFieldValue}
                      className="rounded-full whitespace-nowrap"
                      style={{ minHeight: "44px", fontFamily: "var(--font-dm-sans)" }}
                    >
                      {t("Save and continue", "Guardar y continuar")}
                    </Button>
                  </form>
                </div>
              </div>
            )}

            {parseError && !parseMissingField && (
              <div className="flex justify-start">
                  <div className="max-w-[85%] rounded-2xl rounded-tl-sm px-4 py-3" style={{ backgroundColor: "transparent" }}>
                  <p style={INLINE_ERROR_STYLE}>
                    {parseError}
                  </p>
                </div>
              </div>
            )}

            {quickActionError && (
              <div className="flex justify-start">
                  <div className="max-w-[85%] rounded-2xl rounded-tl-sm px-4 py-3" style={{ backgroundColor: "transparent" }}>
                  <p style={INLINE_ERROR_STYLE}>
                    {quickActionError}
                  </p>
                </div>
              </div>
            )}

            {networkRetryVisible && (
              <div className="flex justify-start">
                <div
                  className="max-w-[85%] rounded-2xl rounded-tl-sm px-4 py-3 flex flex-col gap-2"
                  style={{ backgroundColor: "var(--warning-soft, #fff8e1)", border: "1px solid var(--warning, #f59e0b)" }}
                >
                  <p style={{ ...INLINE_ERROR_STYLE, color: "var(--warning, #b45309)" }}>
                    {t("No connection. Tap Retry or wait for signal.", "Sin conexión. Tocá Reintentar o esperá señal.")}
                  </p>
                  <Button
                    type="button"
                    onClick={handleNetworkRetry}
                    className="self-start rounded-full"
                    style={{
                      minHeight: "44px",
                      fontFamily: "var(--font-dm-sans)",
                      backgroundColor: "var(--warning, #f59e0b)",
                      color: "#fff",
                    }}
                  >
                    {t("Retry", "Reintentar")}
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
        <div ref={chatThreadBottomRef} />
      </div>
      <style jsx>{`
        @media (max-width: 767px) {
          .assistant-thread-feed {
            gap: 0.4rem;
            padding-top: 0;
            padding-bottom: 0.1rem;
            padding-left: max(1rem, env(safe-area-inset-left, 0px));
            padding-right: max(1rem, env(safe-area-inset-right, 0px));
          }
          .assistant-bubble {
            max-width: 92% !important;
          }
        }
      `}</style>
    </div>
    {showScrollFab && (
      <button
        type="button"
        onClick={() => {
          chatVirtualizer.scrollToIndex(chatHistory.length - 1, { align: "end" });
          setShowScrollFab(false);
        }}
        aria-label={t("Scroll to bottom", "Bajar al final")}
        style={{
          position: "absolute",
          right: "16px",
          bottom: "16px",
          width: "48px",
          height: "48px",
          borderRadius: "50%",
          background: "var(--surface)",
          border: "1px solid var(--border)",
          boxShadow: "var(--shadow-md, 0 4px 12px rgba(0,0,0,0.15))",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          cursor: "pointer",
          zIndex: 10,
        }}
      >
        <CaretDown size={20} weight="bold" style={{ color: "var(--tone-body)" }} />
      </button>
    )}
    </div>
  );
}
