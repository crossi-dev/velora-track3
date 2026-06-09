"use client";

// Auto-scroll hook for the Cobro QR card.
// Scrolls the card into view when draft status becomes "pending" (freshly generated).
// Respects prefers-reduced-motion: instant scroll if user prefers it.

import { type RefObject, useEffect } from "react";

export function useCobroScrollIntoView(
  ref: RefObject<HTMLDivElement | null>,
  status: string,
): void {
  useEffect(() => {
    if (status === "pending" && ref.current) {
      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      ref.current.scrollIntoView({
        block: "center",
        behavior: reduced ? "auto" : "smooth",
      });
    }
  }, [ref, status]);
}
