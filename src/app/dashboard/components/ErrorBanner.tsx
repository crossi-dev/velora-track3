"use client";

import { X } from "@phosphor-icons/react";

interface ErrorBannerProps {
  message: string;
  variant?: "default" | "compact";
  onDismiss?: () => void;
  onRetry?: () => void;
  /** Optional translation helper — e.g. `(en, es) => lang === "es" ? es : en`. Falls back to English when absent. */
  t?: (en: string, es: string) => string;
}

export function ErrorBanner({ message, variant = "default", onDismiss, onRetry, t }: ErrorBannerProps) {
  const tr = t ?? ((en: string) => en);
  const compact = variant === "compact";
  const hasActions = onDismiss !== undefined || onRetry !== undefined;
  return (
    <div
      role="alert"
      style={{
        background: "var(--danger-soft)",
        color: "var(--danger)",
        border: "1px solid color-mix(in srgb, var(--danger) 25%, transparent)",
        borderRadius: "var(--radius-md)",
        padding: compact ? "var(--space-2) var(--space-3)" : "var(--space-3) var(--space-4)",
        fontFamily: "var(--font-dm-sans)",
        fontSize: "0.875rem",
        lineHeight: 1.5,
        display: hasActions ? "flex" : undefined,
        alignItems: hasActions ? "center" : undefined,
        gap: hasActions ? "0.5rem" : undefined,
      }}
    >
      <span style={{ flex: hasActions ? 1 : undefined }}>{message}</span>
      {onRetry !== undefined && (
        <button
          type="button"
          onClick={onRetry}
          style={{
            flexShrink: 0,
            minHeight: "44px",
            padding: "0 0.875rem",
            background: "none",
            border: "1px solid color-mix(in srgb, var(--danger) 40%, transparent)",
            borderRadius: "var(--radius-md)",
            color: "var(--danger)",
            fontFamily: "var(--font-dm-sans)",
            fontSize: "0.875rem",
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          {tr("Retry", "Reintentar")}
        </button>
      )}
      {onDismiss !== undefined && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label={tr("Dismiss", "Cerrar")}
          style={{
            flexShrink: 0,
            width: "44px",
            height: "44px",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            background: "none",
            border: "none",
            cursor: "pointer",
            color: "var(--danger)",
            borderRadius: "var(--radius-md)",
          }}
        >
          <X size={16} strokeWidth={2.5} aria-hidden />
        </button>
      )}
    </div>
  );
}
