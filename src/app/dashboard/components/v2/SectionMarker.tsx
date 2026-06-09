"use client";

import type { CSSProperties } from "react";

interface SectionMarkerProps {
  /** Label like "Stock", "Caja", "Reportes". Rendered uppercase. */
  label: string;
  /** Numeric pad like "03". Optional — when omitted, just the dot + label. */
  number?: string | number;
  /** Use this on dark surfaces (navy hero blocks). Adjusts colors for contrast. */
  onDark?: boolean;
  /** Forward style for layout (margins, etc.). */
  style?: CSSProperties;
  /** Optional className passthrough. */
  className?: string;
}

/**
 * Editorial section marker — "● Sección · 03" — used at the top of every
 * page above the title. Anchors each screen in the v2 brand system.
 *
 * Design system reference: Velora Handoff.html, "section-marker" pattern.
 * Uses the .section-marker base class from tokens.css for the dot + uppercase
 * tracking; on-dark variant flips to cream tones.
 */
export function SectionMarker({ label, number, onDark, style, className }: SectionMarkerProps) {
  return (
    <div
      className={`section-marker${onDark ? " on-dark" : ""}${className ? ` ${className}` : ""}`}
      style={style}
    >
      <span>{label}</span>
      {number !== undefined && number !== "" ? (
        <span style={{ color: onDark ? "rgba(245, 239, 224, 0.62)" : "var(--tone-muted)", fontWeight: 400 }}>
          · {String(number).padStart(2, "0")}
        </span>
      ) : null}
    </div>
  );
}
