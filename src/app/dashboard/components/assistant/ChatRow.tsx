"use client";

import React, { useState, useCallback } from "react";
import type { ChatHistoryEntry } from "../../lib/types";
import { useRole } from "../../lib/contexts";
import { useT } from "../../lib/DashboardLangContext";
import { formatDateLabel } from "../../lib/helpers";
import { formatTraceText, formatTimestamp, formatTimeAgo, extractSuggestion, BUBBLE_TEXT_BASE } from "./chat-helpers";
import { ActivityRow } from "./ActivityRow";
import { AgentActivityCard } from "./AgentActivityCard";
import { ChipButtons } from "./ChipButtons";
import { WidgetRenderer } from "./WidgetRenderer";

const BUBBLE_SENT_STYLE: React.CSSProperties = { backgroundColor: "var(--bubble-sent)" };
const BUBBLE_RECEIVED_STYLE: React.CSSProperties = { backgroundColor: "var(--bubble-received)", border: "1px solid var(--bubble-border)" };

const TIMESTAMP_BASE: React.CSSProperties = {
  opacity: 0.6,
  marginTop: "2px",
};

const DATE_DIVIDER_STYLE: React.CSSProperties = {
  textAlign: "center",
  padding: "12px 0 8px",
  fontWeight: 500,
};

export const ChatRow = React.memo(function ChatRow({
  entry,
  showDateDivider,
  onSuggest,
  onSendChip,
  loadingParse = false,
}: {
  entry: ChatHistoryEntry;
  showDateDivider: boolean;
  onSuggest?: (text: string) => void;
  onSendChip?: (text: string) => void;
  loadingParse?: boolean;
}) {
  const role = useRole();
  const t = useT();
  const isUser = entry.kind === "user";
  const isManager = entry.source === "manager";
  const suggestion = isManager && role === "employee" && onSuggest ? extractSuggestion(entry.text) : null;
  const showAck = isManager && role === "employee";
  const [acked, setAcked] = useState(() => {
    if (typeof window === "undefined") return false;
    try { return window.localStorage.getItem(`acked-msg-${entry.id}`) === "1"; } catch { return false; }
  });
  const handleAck = useCallback(() => {
    try { window.localStorage.setItem(`acked-msg-${entry.id}`, "1"); } catch {}
    setAcked(true);
    fetch("/api/chat/ack", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messageId: entry.id }) }).catch(() => {});
  }, [entry.id]);

  const dateDivider = showDateDivider && entry.timestamp !== undefined
    ? <div className="text-caption" style={DATE_DIVIDER_STYLE}>{formatDateLabel(entry.timestamp)}</div>
    : null;

  if (entry.kind === "success") {
    return <>{dateDivider}<ActivityRow text={entry.text} timestamp={entry.timestamp} /></>;
  }

  return (
    <>
      {dateDivider}
      {/* Canonical 2026 (Vercel AI Elements + shadcn-chatbot-kit): assistant
          messages omit avatar — sender identity is conveyed by alignment +
          bubble tone. user → justify-end / right margin, assistant → justify-start
          / left margin. Matches WhatsApp + iMessage two-party convention. */}
      <div className={isUser ? "flex justify-end" : "flex justify-start"}>
        {/* items-stretch (default) keeps children at their natural width.
            items-end/items-start must NOT be set here — they force align-self
            on every child, which collapses the bubble to min-content and lets
            WKWebView split short words. Each child that needs end/start
            alignment carries its own align-self. (ishadeed.com messenger ref)
            minWidth: "min-content" — a prior fix used minWidth: 0 here
            following the "min-width: 0 to break flex collapse" canonical tip,
            but that applies to ROW-direction flex items overflowing their basis.
            On this column wrapper, minWidth: 0 collapsed the container to 0px
            and the bubble (max-w-[82%]) became ~51px → "hola" wrapped as
            "ho" / "la" (Playwright measured: p.height 49.59px vs lineHeight
            24.8px = ratio 2.0; bubble width 51.36px on every viewport,
            2026-05-27). min-content lets the bubble's natural word width
            drive the wrapper, so short words sit on one line.
            https://defensivecss.dev/tip/flexbox-min-content-size/
            https://developer.mozilla.org/en-US/docs/Web/CSS/min-content */}
        <div className={isUser ? "flex flex-col" : "flex flex-col"}>
          {isManager && (
            <span
              className="text-caption"
              style={{
                fontWeight: 600,
                color: "var(--tone-muted)",
                marginBottom: "4px",
                paddingLeft: "4px",
                alignSelf: "flex-start",
              }}
            >
              ⚡ {t("Velora Manager", "Velora Manager")} · {formatTimeAgo(entry.timestamp)}
            </span>
          )}
          <div
            className={`assistant-bubble px-4 ${
              isUser
                ? "max-w-[82%] rounded-2xl rounded-tr-sm py-3"
                : "max-w-[82%] rounded-2xl rounded-tl-sm py-3"
            }`}
            style={{
              ...(isUser ? BUBBLE_SENT_STYLE : BUBBLE_RECEIVED_STYLE),
              opacity: acked ? 0.55 : 1,
              transition: "opacity 0.2s",
              // align-self on the bubble itself (not inherited from parent items-end)
              // + explicit width: fit-content. Together these let WKWebView size
              // the bubble to content without collapsing to min-content.
              // minWidth: min-content sets the floor at the widest single WORD so
              // short words ("hola", "sí", "ok") never wrap. PREVIOUSLY this was
              // max-content which is the ENTIRE TEXT in one line — that made long
              // messages overflow horizontally past the viewport (Carlos screenshot
              // 2026-05-28: "Soy Velora — el chat que opera tu negocio enter[CUT]").
              // max-w-[82%] still caps long messages. Canonical WhatsApp / iOS Messages pattern.
              // Source: developer.mozilla.org/.../CSS/min-content vs max-content.
              alignSelf: isUser ? "flex-end" : "flex-start",
              width: "fit-content",
              minWidth: "min-content",
            }}
          >
            <p
              className="chat-bubble-text text-body"
              style={{
                ...BUBBLE_TEXT_BASE,
                color: entry.kind === "error" ? "var(--danger)" : "var(--tone-strong)",
              }}
            >
              {formatTraceText(entry.text)}
            </p>
          </div>
          {!isUser && entry.agentActivity && entry.agentActivity.length > 0 && (
            <AgentActivityCard activities={entry.agentActivity} t={t} />
          )}
          {!isUser && entry.chips && onSendChip && (
            <ChipButtons bundle={entry.chips} onSendChip={onSendChip} role={role} loadingParse={loadingParse} />
          )}
          {!isUser && entry.widget && (
            <WidgetRenderer widget={entry.widget} />
          )}
          {suggestion && (
            <button
              type="button"
              onClick={() => onSuggest!(suggestion)}
              style={{
                marginTop: "6px",
                padding: "6px 14px",
                minHeight: "44px",
                background: "var(--action-primary-bg)",
                color: "var(--action-primary-fg)",
                border: "none",
                borderRadius: "999px",
                cursor: "pointer",
                fontSize: "0.875rem",
                fontWeight: 600,
                lineHeight: 1,
                maxWidth: "100%",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                alignSelf: "flex-start",
              }}
            >
              {suggestion}
            </button>
          )}
          {showAck && (
            <button
              type="button"
              onClick={acked ? undefined : handleAck}
              style={{
                marginTop: "4px",
                paddingLeft: "4px",
                minHeight: "44px",
                background: "none",
                border: "none",
                cursor: acked ? "default" : "pointer",
                color: acked ? "var(--success, #22c55e)" : "var(--tone-muted)",
                fontSize: "0.875rem",
                fontWeight: 600,
                display: "flex",
                alignItems: "center",
                gap: "4px",
                lineHeight: 1,
                alignSelf: "flex-start",
              }}
            >
              {acked ? t("✓ Done", "✓ Listo") : t("Mark as done", "Marcar como listo")}
            </button>
          )}
          <span
            className="text-caption"
            style={{
              ...TIMESTAMP_BASE,
              paddingLeft: !isUser ? "4px" : undefined,
              paddingRight: isUser ? "4px" : undefined,
              alignSelf: isUser ? "flex-end" : "flex-start",
            }}
          >
            {formatTimestamp(entry.timestamp)}
          </span>
        </div>
      </div>
    </>
  );
});
