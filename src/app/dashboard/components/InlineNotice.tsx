"use client";

import { X } from "@phosphor-icons/react";
import type { FeedbackTone } from "../lib/types";

interface InlineNoticeProps {
  message: string;
  description?: string;
  tone?: FeedbackTone;
  compact?: boolean;
  role?: "status" | "alert";
  onDismiss?: () => void;
  dismissLabel?: string;
}

const TONE_STYLES: Record<FeedbackTone, { borderColor: string; backgroundColor: string; color: string }> = {
  success: {
    borderColor: "var(--success-border)",
    backgroundColor: "var(--success-soft)",
    color: "var(--success)",
  },
  warning: {
    borderColor: "var(--warning-border)",
    backgroundColor: "var(--warning-soft)",
    color: "var(--warning)",
  },
  error: {
    borderColor: "var(--danger-border)",
    backgroundColor: "var(--danger-soft)",
    color: "var(--danger)",
  },
  info: {
    borderColor: "var(--border)",
    backgroundColor: "var(--brand-soft)",
    color: "var(--brand)",
  },
};

export function InlineNotice({
  message,
  description,
  tone = "info",
  compact = false,
  role,
  onDismiss,
  dismissLabel = "Cerrar advertencia",
}: InlineNoticeProps) {
  const palette = TONE_STYLES[tone];

  return (
    <div
      role={role ?? (tone === "error" ? "alert" : "status")}
      aria-live={tone === "error" ? "assertive" : "polite"}
      className="rounded-lg border"
      style={{
        borderColor: palette.borderColor,
        backgroundColor: palette.backgroundColor,
        padding: compact ? "var(--space-2) var(--space-3)" : "var(--space-3) var(--space-4)",
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "0.75rem" }}>
        <div style={{ minWidth: 0 }}>
          <p
            style={{
              fontFamily: "var(--font-dm-sans)",
              fontSize: compact ? "0.875rem" : "0.9375rem",
              fontWeight: compact ? 600 : 700,
              color: palette.color,
              lineHeight: 1.5,
            }}
          >
            {message}
          </p>
          {description ? (
            <p
              className="text-caption"
              style={{
                fontFamily: "var(--font-dm-sans)",
                fontSize: "var(--body-sm)",
                color: "var(--tone-muted)",
                lineHeight: 1.5,
                marginTop: "0.125rem",
              }}
            >
              {description}
            </p>
          ) : null}
        </div>
        {onDismiss ? (
          <button
            type="button"
            aria-label={dismissLabel}
            onClick={onDismiss}
            style={{
              width: "44px",
              height: "44px",
              borderRadius: "9999px",
              border: "1px solid color-mix(in srgb, currentColor 25%, transparent)",
              background: "transparent",
              color: palette.color,
              cursor: "pointer",
              flexShrink: 0,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <X size={14} strokeWidth={2.5} aria-hidden />
          </button>
        ) : null}
      </div>
    </div>
  );
}
