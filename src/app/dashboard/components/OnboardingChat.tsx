"use client";

import { useEffect, useRef, useState } from "react";
import { useChatContext, useInputContext, useBusinessActionsContext } from "../lib/contexts";
import { AssistantInputBar } from "./assistant/AssistantInputBar";
import { TeamSuccessBanner } from "./TeamSuccessBanner";

interface OnboardingTurn {
  role: "user" | "assistant";
  content: string;
}

interface EmployeeAccess {
  name: string;
  pin: string;
  loginUrl: string;
}

const GREETING_EN =
  "Hi, I'm Velora — your business AI.\n\nIn a few minutes we'll set up your catalog, team rules, and employee access. All from here.\n\nWhat's your business name and what type of store is it? (boutique, pet shop, mini-market, restaurant, franchise, etc.)";

const GREETING_ES =
  "Hola, soy Velora — tu IA de negocio.\n\nEn unos minutos configuramos tu catálogo, las reglas del equipo y el acceso de los empleados. Todo desde acá.\n\n¿Cómo se llama tu negocio y qué tipo de comercio es? (boutique, pet shop, mini-market, restaurante, franquicia, etc.)";

const BUBBLE_BASE: React.CSSProperties = {
  fontFamily: "var(--font-dm-sans)",
  fontSize: "0.9375rem",
  lineHeight: 1.55,
  whiteSpace: "pre-wrap",
  padding: "0.75rem 1rem",
  maxWidth: "85%",
};

const BUBBLE_SENT: React.CSSProperties = {
  ...BUBBLE_BASE,
  backgroundColor: "var(--bubble-sent)",
  borderRadius: "1rem 1rem 0.25rem 1rem",
};

const BUBBLE_RECEIVED: React.CSSProperties = {
  ...BUBBLE_BASE,
  backgroundColor: "var(--bubble-received)",
  border: "1px solid var(--bubble-border)",
  borderRadius: "1rem 1rem 1rem 0.25rem",
  color: "var(--tone-strong)",
};

// Identity-reveal bubble — first words Velora speaks to the owner.
// Fraunces italic lifts it out of the operational stream.
const BUBBLE_GREETING: React.CSSProperties = {
  ...BUBBLE_BASE,
  fontFamily: "var(--font-fraunces)",
  fontStyle: "italic",
  fontSize: "clamp(1.125rem, 3vw, 1.375rem)",
  lineHeight: 1.5,
  backgroundColor: "color-mix(in srgb, var(--brand) 6%, var(--surface-raised, var(--surface)))",
  border: "1px solid var(--bubble-border)",
  borderLeft: "4px solid var(--brand)",
  borderRadius: "0 1rem 1rem 0.25rem",
  color: "var(--tone-strong)",
};

interface OnboardingChatProps {
  onComplete: () => void;
}

export function OnboardingChat({ onComplete }: OnboardingChatProps) {
  const { chatHistory, appendChatHistoryEntry } = useChatContext();
  const { input, setInput } = useInputContext();
  const { t } = useBusinessActionsContext();
  const [sending, setSending] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [onboardingHistory, setOnboardingHistory] = useState<OnboardingTurn[]>([]);
  const [pendingBanners, setPendingBanners] = useState<EmployeeAccess[]>([]);
  const injectedRef = useRef(false);
  const pendingInputRef = useRef("");
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;
  const completeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wasAtBottomRef = useRef(true);

  useEffect(() => {
    if (injectedRef.current) return;
    const hasConversation = chatHistory.some((e) => !e.id.startsWith("trace:"));
    if (hasConversation) { injectedRef.current = true; return; }
    injectedRef.current = true;
    // Spanish-first launch: default greeting is es-AR; English copy
    // surfaces only when the owner has flipped the language toggle.
    const greeting = t(GREETING_EN, GREETING_ES);
    appendChatHistoryEntry("reply", greeting);
    setOnboardingHistory([{ role: "assistant", content: greeting }]);
  }, [chatHistory, appendChatHistoryEntry, t]);

  // Clear the completing timeout on unmount to avoid a state update after unmount.
  useEffect(() => {
    return () => {
      if (completeTimerRef.current !== null) {
        clearTimeout(completeTimerRef.current);
      }
    };
  }, []);

  // Track whether the user is parked at the bottom of the scroll container.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const NEAR_BOTTOM_PX = 80;
    const update = () => {
      wasAtBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    return () => el.removeEventListener("scroll", update);
  }, []);

  // Scroll to bottom when the local onboarding history changes, sending toggles,
  // or a new entry lands in chatHistory (e.g. network errors appended via appendChatHistoryEntry).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [onboardingHistory, sending, chatHistory]);

  // Re-pin to bottom when the container resizes (mobile keyboard open/close).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (wasAtBottomRef.current) {
        el.scrollTo({ top: el.scrollHeight, behavior: "instant" });
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  async function handleGo(text?: string) {
    const msg = (text ?? input).trim();
    if (!msg || sending) return;
    setInput("");
    const next: OnboardingTurn[] = [...onboardingHistory, { role: "user", content: msg }];
    setOnboardingHistory(next);
    appendChatHistoryEntry("user", msg);
    setSending(true);
    try {
      const res = await fetch("/api/onboarding-chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ history: next }),
      });
      const data = (await res.json()) as {
        message?: string;
        complete?: boolean;
        error?: string;
        employeeAccess?: EmployeeAccess[];
      };
      if (!res.ok) throw new Error(data.error ?? t("Something went wrong", "Algo salió mal"));
      if (data.message) {
        appendChatHistoryEntry("reply", data.message);
        setOnboardingHistory((prev) => [...prev, { role: "assistant", content: data.message! }]);
      }
      if (data.complete) {
        if (data.employeeAccess && data.employeeAccess.length > 0) {
          setPendingBanners(data.employeeAccess);
        }
        setCompleting(true);
        completeTimerRef.current = setTimeout(() => onCompleteRef.current(), 1000);
      }
    } catch (err) {
      appendChatHistoryEntry("error", err instanceof Error ? err.message : t("Something went wrong", "Algo salió mal"));
    } finally {
      setSending(false);
    }
  }

  const visibleHistory = chatHistory.filter((e) => !e.id.startsWith("trace:"));

  return (
    <div style={{ width: "100%", maxWidth: "44rem", margin: "0 auto", display: "flex", flexDirection: "column", flex: 1, minHeight: 0, padding: "0 1rem" }}>
      <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: "0.75rem", padding: "1rem 0", marginBottom: "0.5rem" }}>
        {visibleHistory.map((entry, idx) => {
          const isFirstMessage = idx === 0 && entry.kind !== "user";
          const avatarSize = isFirstMessage ? 24 : 20;
          const bubbleStyle = entry.kind === "user"
            ? BUBBLE_SENT
            : isFirstMessage
              ? BUBBLE_GREETING
              : BUBBLE_RECEIVED;
          return (
            <div key={entry.id} style={{ display: "flex", justifyContent: entry.kind === "user" ? "flex-end" : "flex-start", alignItems: "flex-start" }}>
              {entry.kind !== "user" && (
                <img
                  src="/velora-mark.svg"
                  alt=""
                  aria-hidden="true"
                  width={avatarSize}
                  height={avatarSize}
                  style={{
                    width: avatarSize,
                    height: avatarSize,
                    flexShrink: 0,
                    marginTop: 4,
                    marginRight: 6,
                    borderRadius: 5,
                  }}
                />
              )}
              <div style={bubbleStyle}>
                {entry.text}
              </div>
            </div>
          );
        })}
        {sending && (
          <div style={{ display: "flex", justifyContent: "flex-start" }}>
            <div style={{ ...BUBBLE_RECEIVED, opacity: 0.6 }}>{t("Thinking…", "Pensando…")}</div>
          </div>
        )}
      </div>
      {pendingBanners.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem", padding: "0.75rem 0" }}>
          {pendingBanners.map((emp) => (
            <TeamSuccessBanner
              key={emp.name}
              notice={t(
                `"${emp.name}" is ready to log in.`,
                `"${emp.name}" ya puede entrar.`,
              )}
              pin={emp.pin}
              loginUrl={emp.loginUrl}
              onDismiss={() => setPendingBanners((prev) => prev.filter((e) => e.name !== emp.name))}
              t={t}
            />
          ))}
        </div>
      )}

      {completing && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: "0.5rem",
            padding: "0.75rem",
            fontFamily: "var(--font-dm-sans)",
            fontSize: "0.9375rem",
            color: "var(--tone-muted)",
          }}
          aria-live="polite"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden={true} className="spinner" style={{ flexShrink: 0 }}>
            <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
          </svg>
          {t("Finishing up…", "Terminando…")}
        </div>
      )}
      <AssistantInputBar
        input={input}
        setInput={setInput}
        handleGo={handleGo}
        // Onboarding doesn't need cancel — no long-running Gemini Pro turns.
        abortCurrentRequest={() => {}}
        loadingParse={sending}
        assistantQuestionContext={null}
        assistantInputHint={null}
        allowShortReply
        t={t}
        pendingInputRef={pendingInputRef}
      />
    </div>
  );
}
