"use client";

import * as React from "react";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

export const LABEL_STYLE = {
  fontFamily: "var(--font-dm-sans)",
  fontSize: "var(--body-sm)",
  color: "var(--tone-muted)",
  fontWeight: 600,
  margin: 0,
  lineHeight: 1.3,
} as const;

// minHeight bumped from 2.5rem (40px) to 2.75rem (44px) to meet WCAG 2.5.5 touch target minimum.
// maxHeight removed — no UX value on a single-line text input, was blocking height growth.
export const COMPACT_FIELD_STYLE = {
  fontFamily: "var(--font-dm-sans)",
  color: "var(--tone-strong)",
  borderColor: "var(--border)",
  backgroundColor: "var(--surface)",
  fontSize: "var(--body-sm)",
  minHeight: "2.75rem",
  padding: "0 0.75rem",
} as const;

export const CARD_CLASS = "settings-card";
export const CARD_STYLE = {
  backgroundColor: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-md)",
  padding: "16px",
} as const;

export const CARD_TITLE_STYLE = {
  fontFamily: "var(--font-dm-sans)",
  fontSize: "var(--body-sm)",
  fontWeight: 700,
  color: "var(--tone-strong)",
  margin: "0 0 12px",
} as const;

export const TOGGLE_ROW_STYLE = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "12px",
  padding: "6px 0",
} as const;

export const TOGGLE_LABEL_STYLE = {
  fontFamily: "var(--font-dm-sans)",
  fontSize: "var(--body-sm)",
  fontWeight: 500,
  color: "var(--tone-body)",
  margin: 0,
} as const;

/** Thin adapter: preserves the `onChange(v: boolean)` API used across all consumers. */
export function Toggle({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <Switch
      checked={checked}
      onCheckedChange={onChange}
      disabled={disabled}
      aria-label={label}
    />
  );
}

/** Thin adapter: preserves the `onChange(v: T)` API used across all consumers.
 *  Radix ToggleGroup handles roving tabIndex + arrow-key navigation natively.
 */
export function SegmentControl<T extends string>({
  options,
  value,
  onChange,
  groupLabel,
}: {
  options: Array<{ value: T; label: string; disabled?: boolean }>;
  value: T;
  onChange: (v: T) => void;
  /** Accessible label for the group (e.g. "Theme selector"). Screen readers announce the group name. */
  groupLabel?: string;
}) {
  return (
    <ToggleGroup
      type="single"
      value={value}
      onValueChange={(v) => {
        // Radix fires onValueChange with "" when the current item is deselected.
        // Preserve the current selection to keep a mandatory-selection invariant.
        if (v) onChange(v as T);
      }}
      aria-label={groupLabel}
    >
      {options.map((opt) => (
        <ToggleGroupItem
          key={opt.value}
          value={opt.value}
          disabled={opt.disabled}
          aria-label={opt.label}
          style={{ fontFamily: "var(--font-dm-sans)", fontSize: "var(--body-sm)" }}
        >
          {opt.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
