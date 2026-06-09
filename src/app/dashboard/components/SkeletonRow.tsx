"use client";

import type { CSSProperties } from "react";

interface SkeletonRowProps {
  count?: number;
}

const LIST_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.5rem",
  width: "100%",
};

const ROW_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.75rem",
  minHeight: "72px",
  width: "100%",
  padding: "0 1rem",
  borderRadius: "var(--radius-md, 8px)",
  backgroundColor: "var(--surface)",
};

const AVATAR_STYLE: CSSProperties = {
  width: "40px",
  height: "40px",
  borderRadius: "50%",
  flexShrink: 0,
};

const COLUMN_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.5rem",
  flex: 1,
  minWidth: 0,
};

const BAR_PRIMARY_STYLE: CSSProperties = {
  width: "60%",
  height: "12px",
};

const BAR_SECONDARY_STYLE: CSSProperties = {
  width: "40%",
  height: "12px",
};

// Inline-injected styles: defines .skeleton-pulse with shimmer animation.
// Kept co-located with the component so the skeleton stays self-contained.
// Uses --skeleton-base/--skeleton-shine tokens for theme-aware shimmer so dark
// mode doesn't collapse to a uniform gray.
const SKELETON_PULSE_CSS = `
@keyframes skeletonShimmer {
  0% { background-position: -200% 0; }
  100% { background-position: 200% 0; }
}
.skeleton-pulse {
  background: linear-gradient(
    90deg,
    var(--skeleton-base, var(--surface-subtle)) 25%,
    var(--skeleton-shine, rgba(0, 0, 0, 0.04)) 50%,
    var(--skeleton-base, var(--surface-subtle)) 75%
  );
  background-size: 200% 100%;
  animation: skeletonShimmer 1.4s ease-in-out infinite;
  border-radius: 6px;
}
@media (prefers-reduced-motion: reduce) {
  .skeleton-pulse {
    animation: none;
  }
}
:where(.dark, [data-theme="dark"]) .skeleton-pulse {
  --skeleton-shine: rgba(255, 255, 255, 0.06);
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .skeleton-pulse {
    --skeleton-shine: rgba(255, 255, 255, 0.06);
  }
}
`;

export function SkeletonRow({ count = 1 }: SkeletonRowProps) {
  const rows = Array.from({ length: Math.max(1, count) }, (_, i) => i);

  return (
    <>
      <style>{SKELETON_PULSE_CSS}</style>
      <div style={LIST_STYLE} aria-hidden>
        {rows.map((i) => (
          <div key={i} style={ROW_STYLE}>
            <div className="skeleton-pulse" style={AVATAR_STYLE} />
            <div style={COLUMN_STYLE}>
              <div className="skeleton-pulse" style={BAR_PRIMARY_STYLE} />
              <div className="skeleton-pulse" style={BAR_SECONDARY_STYLE} />
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
