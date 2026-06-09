"use client";

// Item del popover paperclip (AssistantAttachMenu). Se separa del menú
// principalmente para mantener el archivo del menú bajo el límite de 300
// líneas — el ícono de cada opción es lo más voluminoso.

import React from "react";

export type AttachMenuOption = "camera" | "gallery" | "file";

interface AssistantAttachMenuItemProps {
  option: AttachMenuOption;
  t: (en: string, es: string) => string;
  onSelect: () => void;
  onHover: () => void;
}

export const AssistantAttachMenuItem = React.forwardRef<
  HTMLButtonElement,
  AssistantAttachMenuItemProps
>(function AssistantAttachMenuItem({ option, t, onSelect, onHover }, ref) {
  const label =
    option === "camera"
      ? t("Camera", "Cámara")
      : option === "gallery"
        ? t("Gallery", "Galería")
        : t("File", "Archivo");

  return (
    <button
      ref={ref}
      type="button"
      role="menuitem"
      onClick={onSelect}
      onMouseEnter={onHover}
      onFocus={onHover}
      className="flex items-center gap-3 rounded-md text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 hover:bg-[var(--surface-subtle)] focus:bg-[var(--surface-subtle)]"
      style={{
        minHeight: "44px",
        minWidth: "44px",
        padding: "10px 14px",
        background: "transparent",
        border: "none",
        cursor: "pointer",
        color: "var(--tone-strong)",
        fontFamily: "var(--font-dm-sans)",
        fontSize: "0.9375rem",
        fontWeight: 500,
        outlineColor: "var(--brand)",
      }}
    >
      <span
        aria-hidden
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: "24px",
          height: "24px",
          color: "var(--tone-muted)",
        }}
      >
        {option === "camera" && (
          <svg
            viewBox="0 0 24 24"
            className="h-5 w-5"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
            <circle cx="12" cy="13" r="4" />
          </svg>
        )}
        {option === "gallery" && (
          <svg
            viewBox="0 0 24 24"
            className="h-5 w-5"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <circle cx="8.5" cy="8.5" r="1.5" />
            <path d="M21 15l-5-5L5 21" />
          </svg>
        )}
        {option === "file" && (
          <svg
            viewBox="0 0 24 24"
            className="h-5 w-5"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
          </svg>
        )}
      </span>
      <span>{label}</span>
    </button>
  );
});
