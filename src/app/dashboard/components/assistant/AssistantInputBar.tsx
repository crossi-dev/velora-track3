"use client";

import React, { useCallback, useRef, useEffect } from "react";
import { Capacitor } from "@capacitor/core";
import { useSpeechRecognition } from "../../lib/useSpeechRecognition";
import { getAppSettings } from "../../lib/appSettings";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useFirstLoginTips } from "../../lib/hooks/useFirstLoginTips";
import { AssistantAttachMenu } from "./AssistantAttachMenu";
import { Button } from "@/components/ui/button";

interface AssistantInputBarProps {
  input: string;
  setInput: (value: string) => void;
  handleGo: (text?: string) => void;
  abortCurrentRequest: () => void;
  loadingParse: boolean;
  assistantQuestionContext: string | null;
  assistantInputHint: string | null;
  allowShortReply: boolean;
  t: (en: string, es: string) => string;
  pendingInputRef: React.MutableRefObject<string>;
  isMobileViewport?: boolean;
  catalogNames?: string[];
  onFileSelect?: (file: File) => void;
  onPhotoSelect?: (file: File) => void;
  /** Photo handler for T12 customer-list extraction. */
  onCustomerPhotoSelect?: (file: File) => void;
  onPhotoPrime?: (message: string) => void;
  focusTrigger?: number;
  /** Number of visible chat messages. Tooltip is hidden once the user has at least one message. */
  messageCount?: number;
}

// eslint-disable-next-line max-lines-per-function -- composition root, not a logic violation
export const AssistantInputBar = React.memo(function AssistantInputBar({
  input,
  setInput,
  handleGo,
  abortCurrentRequest,
  loadingParse,
  assistantQuestionContext,
  assistantInputHint,
  allowShortReply,
  t,
  pendingInputRef,
  isMobileViewport = false,
  catalogNames,
  onFileSelect,
  onPhotoSelect,
  onCustomerPhotoSelect,
  onPhotoPrime,
  focusTrigger,
  messageCount = 0,
}: AssistantInputBarProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const { showMic, showInput, dismissMic, dismissInput } = useFirstLoginTips();
  // [H1] Save typed text before mic starts so it can be restored
  const savedInputRef = useRef("");

  const {
    speechSupported,
    listening,
    interimTranscript,
    permissionDenied,
    speechError,
    timerDisplayRef,
    handleMicClick: rawHandleMicClick,
  } = useSpeechRecognition({
    allowShortReply,
    catalogNames,
    onFinalResult: (text, autoSend) => {
      if (autoSend) {
        // [M4] Set pendingInputRef before autoSend handleGo
        pendingInputRef.current = text;
        handleGo(text);
      } else {
        // [H1] Append voice text to saved typed text (don't replace)
        const saved = savedInputRef.current;
        const combined = saved ? saved + " " + text : text;
        setInput(combined);
        savedInputRef.current = "";
      }
    },
  });

  // [H1] Wrap mic click to save current input before recording starts
  const handleMicClick = useCallback(() => {
    if (!listening) {
      // Starting recording — save whatever the user typed
      savedInputRef.current = input;
    } else {
      // Stopping — savedInputRef is used in onFinalResult above
    }
    rawHandleMicClick();
  }, [listening, input, rawHandleMicClick]);

  // Textarea + send-button handlers memoized alongside React.memo on the
  // wrapper so future splits of this bar into memoized subcomponents
  // won't silently regress. The textarea/button themselves are DOM
  // elements so the useCallback isn't load-bearing today, but it's the
  // idiomatic pairing with React.memo.
  const handleTextareaChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      // Strip CR/LF on input. Newlines in a command-chat textarea serve
      // no purpose (Enter submits, multi-line pastes confuse both the
      // user and the parser) and Android Gboard's mic can insert them
      // between dictated fragments — producing split words like
      // "stoc\nk" that the parser can't match even after our
      // collapseSplitKeywords pass. Collapse them to a single space at
      // the input boundary so state stays clean.
      setInput(e.target.value.replace(/[\r\n]+/g, " "));
      const el = e.target;
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
    },
    [setInput]
  );

  const handleTextareaKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        if (loadingParse || !input.trim()) {
          e.preventDefault();
          return;
        }
        e.preventDefault();
        pendingInputRef.current = input;
        void handleGo();
      }
    },
    [loadingParse, input, pendingInputRef, handleGo]
  );

  const handleSendClick = useCallback(() => {
    if (!loadingParse && input.trim()) {
      pendingInputRef.current = input;
      void handleGo();
    }
  }, [loadingParse, input, pendingInputRef, handleGo]);

  useEffect(() => {
    if (!input && textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }, [input]);

  // Track whether a send was in flight so we can re-focus when the
  // response lands, even if the user started typing a new message during
  // loading (which would leave `input` non-empty and break the old
  // `!input && !loadingParse` gate).
  const sendInFlightRef = useRef(false);
  useEffect(() => {
    if (loadingParse) {
      sendInFlightRef.current = true;
    } else if (sendInFlightRef.current) {
      sendInFlightRef.current = false;
      // Re-focus after send completes (desktop only — on mobile would raise keyboard).
      // Sync window check, NOT isMobileViewport state: state hydrates from SSR
      // initial `false`, so on mobile this effect would fire before the resize
      // listener corrects the viewport, popping the keyboard unexpectedly.
      if (textareaRef.current && typeof window !== "undefined" && window.innerWidth >= 768) {
        textareaRef.current.focus();
      }
    }
  }, [loadingParse]);

  // Focus on mount (initial load + tab-switch back, since the parent unmounts
  // AssistantInput when activeTab !== "main"). Desktop only — same SSR-flicker
  // reasoning as above.
  //
  // The 120ms delay matters: useEffect fires after React commit but BEFORE
  // browser paint completes the autofill/scroll into-view passes that other
  // effects in the chat tree trigger. Without the delay the focus() call wins
  // synchronously but then loses focus a tick later when AssistantHistory
  // settles its scroll. Empirically 120ms is enough to land focus reliably
  // across cold loads, tab switches, and refreshes.
  useEffect(() => {
    if (typeof window === "undefined" || window.innerWidth < 768) return;
    const t = window.setTimeout(() => {
      textareaRef.current?.focus();
    }, 120);
    return () => window.clearTimeout(t);
  }, []);

  // Focus on chip suggestion. Mobile included: chip-tap is an explicit user
  // action, so popping the keyboard is the intent (input is already filled,
  // they're about to send or edit).
  useEffect(() => {
    if (focusTrigger && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [focusTrigger]);

  return (
    <div
      className="assistant-composer-footer"
      style={{
        flexShrink: 0,
        position: "relative",
        backgroundColor: "var(--background)",
        padding: isMobileViewport
          ? `6px max(16px, env(safe-area-inset-right, 0px)) 6px max(16px, env(safe-area-inset-left, 0px))`
          : "10px 12px calc(10px + env(safe-area-inset-bottom, 0px))",
      }}
    >
      <div className="assistant-composer-inner" style={{ maxWidth: isMobileViewport ? "none" : "48rem", margin: "0 auto" }}>
        <div className="w-full">
          {/* [H2] Permission denied / error feedback */}
          {(permissionDenied || speechError) && (
            permissionDenied ? (
              <Button
                type="button"
                aria-label="Abrir configuración para activar micrófono"
                onClick={() => {
                  if (Capacitor.isNativePlatform()) {
                    // Best-effort: Android/iOS WebView typically handles these URI schemes
                    // to open app settings. App.openUrl was removed in @capacitor/app v6+.
                    window.location.href = Capacitor.getPlatform() === "android"
                      ? "app-settings:"
                      : "app-settings:";
                  }
                  // Web: no actionable deep-link; button text is informational only
                }}
                variant="outline"
                className="w-full rounded-lg mb-2 hover:bg-transparent hover:text-[color:var(--brand)]"
                style={{
                  minHeight: "44px",
                  fontFamily: "var(--font-dm-sans)",
                  color: "var(--brand)",
                  borderColor: "var(--brand)",
                  cursor: Capacitor.isNativePlatform() ? "pointer" : "default",
                }}
              >
                {Capacitor.isNativePlatform()
                  ? t("Activate microphone in Settings", "Activar micrófono en Configuración")
                  : t("Enable it in browser Settings", "Activalo en Configuración del navegador")}
              </Button>
            ) : (
              <p className="text-caption" style={{
                fontFamily: "var(--font-dm-sans)",
                color: "var(--danger)",
                textAlign: "center",
                marginBottom: "8px",
              }}>
                {speechError}
              </p>
            )
          )}
          <div
            className={`flex items-center input-card-shell transition-all duration-200 rounded-pill`}
              style={{
                backgroundColor: "var(--surface)",
                border: "1px solid var(--border)",
                // Tighter left padding now that the paperclip lives there —
                // the button has its own 44x44 hit area, so the bar doesn't
                // need extra breathing room before the first child.
                padding: isMobileViewport ? "5px 6px 5px 6px" : "8px 12px 8px 8px",
                gap: isMobileViewport ? "8px" : "12px",
                boxShadow: "none",
                minHeight: isMobileViewport ? "48px" : "68px",
                width: "100%",
                position: "relative",
              }}
          >
            {/*
              Paperclip lives on the LEFT (ChatGPT / Gemini convention).
              Hidden while dictation is active so the listening UI gets full
              width. The popover anchors with `left: 0` from the trigger, so
              moving the trigger to the left side keeps the menu on-screen
              without extra positioning logic.
            */}
            {(onFileSelect || onPhotoSelect) && !listening && (
              <div className="shrink-0">
                <AssistantAttachMenu
                  onFileSelect={onFileSelect}
                  onPhotoSelect={onPhotoSelect}
                  onCustomerPhotoSelect={onCustomerPhotoSelect}
                  onPhotoPrime={onPhotoPrime}
                  t={t}
                />
              </div>
            )}
            {listening ? (
              <div className="flex-1 flex items-center gap-3 min-w-0">
                <div style={{
                  width: "10px",
                  height: "10px",
                  borderRadius: "50%",
                  backgroundColor: "var(--brand)",
                  animation: "pulse 1.5s ease-in-out infinite",
                  flexShrink: 0,
                }} />
                <div className="flex-1 min-w-0">
                  <p
                    className="line-clamp-1 text-body"
                    style={{
                      fontFamily: "var(--font-dm-sans)",
                      color: "var(--tone-strong)",
                      margin: 0,
                      opacity: interimTranscript ? 1 : 0.5
                    }}
                  >
                    {interimTranscript || t("Listening…", "Escuchando…")}
                  </p>
                  <span
                    ref={timerDisplayRef}
                    className="text-caption"
                    style={{
                      fontFamily: "var(--font-dm-sans)",
                      fontWeight: 500,
                      color: "var(--brand)",
                    }}
                  >
                    00:00
                  </span>
                </div>
              </div>
            ) : (
              <div style={{ flex: 1, position: "relative", minWidth: 0 }}>
              {showInput && (
                <div id="velora-input-tooltip" onClick={dismissInput} role="tooltip" style={{ position: "absolute", bottom: "calc(100% + 8px)", left: "50%", transform: "translateX(-50%)", backgroundColor: "var(--tone-strong)", color: "#fff", fontSize: "0.875rem", fontFamily: "var(--font-dm-sans)", fontWeight: 500, padding: "8px 12px", borderRadius: "8px", whiteSpace: "nowrap", zIndex: "var(--z-tooltip)" as unknown as number, cursor: "pointer" }}>
                  {t("Or type what happened", "O escribí lo que pasó")}
                </div>
              )}
              <textarea
                ref={textareaRef}
                value={input}
                aria-describedby="velora-input-tooltip"
                onChange={(e) => { dismissInput(); handleTextareaChange(e); }}
                maxLength={500}
                onKeyDown={handleTextareaKeyDown}
                rows={1}
                placeholder={
                  assistantQuestionContext
                    ? (assistantInputHint ?? t("Type your reply…", "Escribí tu respuesta…"))
                    : t("Ask Velora…", "Preguntá a Velora…")
                }
                className="w-full resize-none leading-[1.55] outline-none placeholder:text-[var(--tone-muted)] focus:outline-none focus:ring-0 text-body"
                style={{
                  fontFamily: "var(--font-dm-sans)",
                  color: "var(--tone-strong)",
                  backgroundColor: "transparent",
                  maxHeight: "200px",
                  minHeight: isMobileViewport ? "30px" : "40px",
                  padding: isMobileViewport ? "8px 0" : "16px 0",
                  outline: "none",
                  boxShadow: "none",
                  appearance: "none",
                  WebkitAppearance: "none",
                  fontSize: "1rem",
                }}
              />
              </div>
            )}

            <div className="flex items-center gap-2 shrink-0">
              {/*
                2026 chat-input pattern (ChatGPT, Gemini, Claude.ai): a single
                right-side action slot that morphs between mic (empty input)
                and send-arrow (input has text). When dictation is active the
                same slot becomes a stop button. We render BOTH icons stacked
                (absolute) and cross-fade by opacity so there's no layout
                flicker between states. Touch target stays 44x44.
              */}
              {(() => {
                // While a Gemini turn is in flight the button morphs into a
                // cancel affordance so the user isn't frozen for 15s.
                if (loadingParse) {
                  return (
                    <button
                      type="button"
                      onClick={abortCurrentRequest}
                      aria-label={t("Cancel", "Cancelar")}
                      title={t("Cancel", "Cancelar")}
                      className="velora-input-action-btn relative inline-flex h-11 w-11 items-center justify-center rounded-full transition-all duration-200 active:scale-90"
                      style={{
                        backgroundColor: "var(--surface-subtle)",
                        color: "var(--tone-muted)",
                        border: "none",
                        boxShadow: "none",
                      }}
                    >
                      {/* Spinner ring — keeps the "in flight" signal visible. */}
                      <svg
                        viewBox="0 0 24 24"
                        className="absolute h-5 w-5 animate-spin"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        aria-hidden
                        style={{ opacity: 0.25 }}
                      >
                        <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
                      </svg>
                      {/* X icon — the actionable cancel target. */}
                      <svg
                        aria-hidden="true"
                        viewBox="0 0 24 24"
                        className="absolute h-4 w-4"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                      >
                        <path d="M18 6 6 18" />
                        <path d="M6 6l12 12" />
                      </svg>
                    </button>
                  );
                }

                const hasText = input.trim().length > 0;
                const showSendMode = hasText && !listening;
                const micSlotEnabled =
                  speechSupported && getAppSettings().voiceEnabled;
                const showMicMode = !showSendMode && micSlotEnabled;
                // If voice isn't supported and there's no text, still render
                // a disabled send button to keep the layout stable.
                const showInertSend = !showSendMode && !showMicMode;

                const onClick = () => {
                  if (showSendMode) {
                    handleSendClick();
                    return;
                  }
                  if (listening || showMicMode) {
                    dismissMic();
                    handleMicClick();
                  }
                };

                const ariaLabel = showSendMode
                  ? t("Send message", "Enviar mensaje")
                  : listening
                    ? t("Stop", "Detener")
                    : t("Speak to chat", "Hablar al chat");

                const button = (
                  <button
                    type="button"
                    onClick={onClick}
                    disabled={
                      showSendMode
                        ? !input.trim()
                        : showInertSend
                          ? true
                          : false
                    }
                    aria-label={ariaLabel}
                    aria-pressed={showMicMode || listening ? listening : undefined}
                    className="velora-input-action-btn relative inline-flex h-11 w-11 items-center justify-center rounded-full transition-all duration-200 active:scale-90 disabled:opacity-30"
                    style={{
                      backgroundColor: showSendMode
                        ? "var(--action-primary-bg)"
                        : listening
                          ? "var(--brand-soft)"
                          : "var(--surface-subtle)",
                      color: showSendMode
                        ? "var(--action-primary-fg)"
                        : listening
                          ? "var(--brand)"
                          : "var(--tone-muted)",
                      border: "none",
                      boxShadow: "none",
                    }}
                  >
                    {/* Send arrow (visible when input has text). */}
                    <svg
                      aria-hidden="true"
                      viewBox="0 0 24 24"
                      className="absolute h-5 w-5"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      style={{
                        opacity: showSendMode ? 1 : 0,
                        transform: showSendMode ? "scale(1)" : "scale(0.85)",
                        transition: "opacity 150ms ease, transform 150ms ease",
                      }}
                    >
                      <path d="M12 19V5" />
                      <path d="M5 12l7-7 7 7" />
                    </svg>
                    {/* Mic icon (visible when input is empty and not listening). */}
                    <svg
                      aria-hidden="true"
                      viewBox="0 0 24 24"
                      className="absolute h-5 w-5"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      style={{
                        opacity: showMicMode && !listening ? 1 : 0,
                        transform:
                          showMicMode && !listening ? "scale(1)" : "scale(0.85)",
                        transition: "opacity 150ms ease, transform 150ms ease",
                      }}
                    >
                      <path d="M12 15a3 3 0 0 0 3-3V7a3 3 0 1 0-6 0v5a3 3 0 0 0 3 3Z" />
                      <path d="M19 12a7 7 0 0 1-14 0" />
                      <path d="M12 19v3" />
                    </svg>
                    {/* Stop square (visible while dictation is active). */}
                    <svg
                      aria-hidden="true"
                      viewBox="0 0 24 24"
                      className="absolute h-5 w-5"
                      fill="currentColor"
                      style={{
                        opacity: listening ? 1 : 0,
                        transform: listening ? "scale(1)" : "scale(0.85)",
                        transition: "opacity 150ms ease, transform 150ms ease",
                      }}
                    >
                      <rect x="7" y="7" width="10" height="10" rx="2" />
                    </svg>
                  </button>
                );

                // Wrap with the first-login mic tooltip only while the slot
                // is genuinely the mic (matches prior UX so the coachmark
                // doesn't fire over a send arrow).
                if (showMicMode && !listening) {
                  // Hide tooltip once the user has any chat history — they already know how it works.
                  const tipVisible = showMic && messageCount === 0;
                  return (
                    <TooltipProvider>
                      <Tooltip open={tipVisible} onOpenChange={(open) => { if (!open) dismissMic(); }}>
                        <TooltipTrigger asChild>{button}</TooltipTrigger>
                        <TooltipContent side="top">
                          {t("Speak to record a sale", "Hablá para registrar una venta")}
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  );
                }
                return button;
              })()}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
});
