// SettingsCourierCard.styles.ts — shared style constants for the courier settings card.
// Extracted from SettingsCourierCard.form.tsx to keep that file under the 400-line budget.

import type React from "react";

export const HINT_TEXT: React.CSSProperties = {
  fontSize: "0.875rem",
  color: "var(--tone-muted)",
  margin: 0,
  fontFamily: "var(--font-dm-sans)",
  fontStyle: "italic",
};

export const ERROR_TEXT: React.CSSProperties = {
  color: "var(--danger)",
  fontSize: "0.875rem",
  marginTop: "0.25rem",
  fontFamily: "var(--font-dm-sans)",
};

export const LABEL_STYLE_BLOCK: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.25rem",
};

export const LABEL_TEXT_STYLE: React.CSSProperties = {
  fontFamily: "var(--font-dm-sans)",
  fontSize: "0.8125rem",
  fontWeight: 600,
  color: "var(--tone-muted)",
};

export const CRED_INPUT_STYLE: React.CSSProperties = {
  fontFamily: "var(--font-dm-sans)",
  fontSize: "1rem",
  height: "2.5rem",
  padding: "0 0.75rem",
  borderRadius: "0.5rem",
  border: "1px solid var(--border)",
  backgroundColor: "var(--surface)",
  color: "var(--tone-strong)",
  width: "100%",
  maxWidth: "24rem",
};

export function primaryButtonStyle(): React.CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    minHeight: "2.25rem",
    padding: "0.5rem 1rem",
    fontSize: "1rem",
    fontWeight: 600,
    borderRadius: "0.5rem",
    border: "none",
    cursor: "pointer",
    backgroundColor: "var(--tone-strong, #111827)",
    color: "var(--surface, #ffffff)",
    alignSelf: "flex-start",
  };
}

export function secondaryButtonStyle(disabled: boolean): React.CSSProperties {
  return {
    minHeight: "2.25rem",
    padding: "0.5rem 1rem",
    fontSize: "1rem",
    fontWeight: 600,
    borderRadius: "0.5rem",
    border: "1px solid var(--border, #d1d5db)",
    backgroundColor: "transparent",
    color: "var(--tone-strong, #111827)",
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.6 : 1,
    alignSelf: "flex-start",
  };
}
