"use client";

import type { CSSProperties, ReactNode } from "react";
import { Button } from "@/components/ui/button";

interface SharedEmptyStateAction {
  label: string;
  onClick: () => void;
}

interface SharedEmptyStateProps {
  illustration?: ReactNode;
  title: string;
  description?: string;
  action?: SharedEmptyStateAction;
}

const CONTAINER_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  textAlign: "center",
  padding: "2rem",
  gap: "1rem",
  animation: "fadeUp 0.45s var(--ease-out, ease) both",
  willChange: "opacity, transform",
};

const ILLUSTRATION_WRAP_STYLE: CSSProperties = {
  width: "112px",
  height: "112px",
  borderRadius: "50%",
  background:
    "radial-gradient(circle at 30% 30%, var(--brand-soft), rgba(74, 127, 191, 0.06) 72%)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  flexShrink: 0,
  boxShadow: "0 1px 0 0 rgba(27, 58, 107, 0.04) inset",
};

// Branded default illustration: soft brand glow + abstract spark shape.
// Inline SVG keeps the bundle small and honors currentColor for theming.
function DefaultBrandedIllustration() {
  return (
    <svg
      width="52"
      height="52"
      viewBox="0 0 52 52"
      fill="none"
      aria-hidden
      style={{ color: "var(--brand)" }}
    >
      <defs>
        <linearGradient id="velora-empty-gradient" x1="0" y1="0" x2="52" y2="52" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="currentColor" stopOpacity="0.95" />
          <stop offset="1" stopColor="currentColor" stopOpacity="0.55" />
        </linearGradient>
      </defs>
      {/* Abstract orbit ring */}
      <circle cx="26" cy="26" r="18" stroke="currentColor" strokeOpacity="0.18" strokeWidth="1.5" strokeDasharray="3 4" />
      {/* Brand spark */}
      <path
        d="M26 10 L29.2 22.8 L42 26 L29.2 29.2 L26 42 L22.8 29.2 L10 26 L22.8 22.8 Z"
        fill="url(#velora-empty-gradient)"
      />
      {/* Satellite dot */}
      <circle cx="40" cy="14" r="2.5" fill="currentColor" fillOpacity="0.55" />
    </svg>
  );
}

const TITLE_STYLE: CSSProperties = {
  margin: 0,
  maxWidth: "22rem",
};

const DESCRIPTION_STYLE: CSSProperties = {
  margin: 0,
  maxWidth: "22rem",
  color: "var(--tone-muted)",
  lineHeight: 1.5,
};

export function SharedEmptyState({
  illustration,
  title,
  description,
  action,
}: SharedEmptyStateProps) {
  return (
    <div style={CONTAINER_STYLE}>
      <div style={ILLUSTRATION_WRAP_STYLE} aria-hidden>
        {illustration ?? <DefaultBrandedIllustration />}
      </div>

      <h3 className="text-title" style={TITLE_STYLE}>
        {title}
      </h3>

      {description && (
        <p className="text-caption" style={DESCRIPTION_STYLE}>
          {description}
        </p>
      )}

      {action && (
        <Button type="button" onClick={action.onClick} className="mt-1">
          {action.label}
        </Button>
      )}
    </div>
  );
}
