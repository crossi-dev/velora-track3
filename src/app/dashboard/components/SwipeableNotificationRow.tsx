"use client";

import { useCallback, useEffect, useRef } from "react";

const SWIPE_THRESHOLD = 80;
// Minimum horizontal distance before we commit to a horizontal swipe and
// suppress vertical scroll. Kept intentionally low so the lock engages early.
const AXIS_LOCK_THRESHOLD = 8;

export function SwipeableNotificationRow({
  children,
  itemId,
  onDismiss,
}: {
  children: React.ReactNode;
  itemId: string;
  onDismiss: (id: string) => void;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  const startXRef = useRef<number | null>(null);
  const startYRef = useRef<number | null>(null);
  const currentXRef = useRef(0);
  // true once we've committed this gesture to the horizontal axis
  const axisLockedRef = useRef(false);

  // We use a native (non-passive) touchmove listener so we can call
  // preventDefault() to suppress vertical scroll once the axis is locked.
  // React's synthetic onTouchMove is always passive in React 19, so we
  // must attach this manually.
  useEffect(() => {
    const el = rowRef.current;
    if (!el) return;

    const handleTouchMove = (e: TouchEvent) => {
      if (startXRef.current === null || startYRef.current === null) return;
      const dx = e.touches[0].clientX - startXRef.current;
      const dy = e.touches[0].clientY - startYRef.current;

      if (!axisLockedRef.current) {
        // Commit to horizontal only if horizontal motion dominates
        if (Math.abs(dx) > AXIS_LOCK_THRESHOLD && Math.abs(dx) > Math.abs(dy)) {
          axisLockedRef.current = true;
        } else if (Math.abs(dy) > AXIS_LOCK_THRESHOLD) {
          // Vertical scroll won — ignore this gesture
          return;
        } else {
          return; // not yet enough movement to decide
        }
      }

      // Axis is locked horizontal — suppress scroll
      e.preventDefault();

      if (dx >= 0) { currentXRef.current = 0; if (el) el.style.transform = ""; return; }
      currentXRef.current = dx;
      el.style.transform = `translateX(${dx}px)`;
    };

    el.addEventListener("touchmove", handleTouchMove, { passive: false });
    return () => el.removeEventListener("touchmove", handleTouchMove);
  }, []);

  const onTouchStart = useCallback((e: React.TouchEvent) => {
    startXRef.current = e.touches[0].clientX;
    startYRef.current = e.touches[0].clientY;
    currentXRef.current = 0;
    axisLockedRef.current = false;
  }, []);

  const onTouchEnd = useCallback(() => {
    if (currentXRef.current < -SWIPE_THRESHOLD) {
      if (rowRef.current) {
        rowRef.current.style.transition = "transform 200ms ease-out, opacity 200ms ease-out";
        rowRef.current.style.transform = "translateX(-100%)";
        rowRef.current.style.opacity = "0";
      }
      setTimeout(() => onDismiss(itemId), 200);
    } else if (rowRef.current) {
      rowRef.current.style.transition = "transform 150ms ease-out";
      rowRef.current.style.transform = "";
      setTimeout(() => { if (rowRef.current) rowRef.current.style.transition = ""; }, 150);
    }
    startXRef.current = null;
    startYRef.current = null;
    currentXRef.current = 0;
    axisLockedRef.current = false;
  }, [onDismiss, itemId]);

  return (
    <div
      ref={rowRef}
      // touch-action: pan-y allows vertical scroll by default; the native
      // listener above overrides this selectively once axis is locked.
      style={{ touchAction: "pan-y" }}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
    >
      {children}
    </div>
  );
}
