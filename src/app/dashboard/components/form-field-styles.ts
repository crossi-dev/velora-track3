// Shared form-field style constants — used by ClientsSubTab, SuppliersSubTab,
// and ProductDetailSheet. Extracted 2026-05-29 to eliminate 3× duplication.
// NOTE: SettingsShared.tsx exports its own LABEL_STYLE with different properties
// (no display:flex, uses var(--body-sm)) — intentionally kept separate.

export const LABEL_STYLE = {
  display: "flex",
  flexDirection: "column" as const,
  gap: "0.25rem",
};

export const LABEL_TEXT_STYLE = {
  fontFamily: "var(--font-dm-sans)",
  fontSize: "0.875rem",
  color: "var(--tone-muted)",
};
