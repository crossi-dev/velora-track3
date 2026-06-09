"use client";

import { useEffect, useRef } from "react";

const FOCUSABLE_SELECTORS =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Traps keyboard focus within a dialog element while `active` is true.
 *
 * On activate:
 *   - Saves the previously-focused element so it can be restored on deactivate.
 *   - Moves focus into the dialog (first focusable descendant, or the element
 *     itself — the container gets tabIndex=-1 as fallback so focus always lands).
 *   - When `initialFocusRef` is provided, that element is focused instead of
 *     the first focusable descendant. Use this to point focus at a specific
 *     button (e.g. a primary confirmation action) without a competing useEffect.
 *
 * On deactivate:
 *   - Restores focus to the element that was focused before the trap was armed.
 *
 * Tab / Shift+Tab cycle within the dialog's focusable descendants.
 *
 * IMPORTANT: call this hook inside a component that is mounted ONLY while the
 * dialog is open (or ensure the ref points at an element that is in the DOM
 * whenever active is true). If the component renders a conditional `return null`
 * before the ref element, extract the dialog body into an inner component that
 * is mounted only when the dialog is open.
 */
export function useFocusTrap(
  ref: React.RefObject<HTMLElement | null>,
  active: boolean,
  initialFocusRef?: React.RefObject<HTMLElement | null>,
): void {
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!active) {
      // Restore focus when the trap deactivates, then clear the saved ref so a
      // subsequent activation starts fresh (avoids StrictMode double-capture
      // pointing previousFocusRef at an element inside the dialog).
      if (previousFocusRef.current) {
        previousFocusRef.current.focus();
        previousFocusRef.current = null;
      }
      return;
    }

    // Only capture the previously-focused element on the FIRST activation run.
    // Under React StrictMode the effect executes twice on mount; without this
    // guard the second run would record an element inside the dialog and restore
    // focus there on close instead of to the original trigger.
    if (!previousFocusRef.current) {
      previousFocusRef.current = document.activeElement as HTMLElement | null;
    }

    const el = ref.current;
    if (!el) return;

    // Ensure the container can receive focus as a last resort (e.g. when it has
    // no focusable descendants). We track whether we added the attribute so we
    // can remove it on cleanup.
    let addedTabIndex = false;
    if (!el.hasAttribute("tabindex")) {
      el.setAttribute("tabindex", "-1");
      addedTabIndex = true;
    }

    // Move focus: honour initialFocusRef when provided, otherwise fall back to
    // the first focusable descendant, then the container itself.
    const target =
      initialFocusRef?.current ??
      el.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTORS)[0] ??
      el;
    target.focus();

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key !== "Tab") return;
      const panel = ref.current;
      if (!panel) return;

      const nodes = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTORS));
      if (nodes.length === 0) {
        e.preventDefault();
        return;
      }

      const firstNode = nodes[0];
      const lastNode = nodes[nodes.length - 1];

      if (e.shiftKey) {
        if (document.activeElement === firstNode) {
          e.preventDefault();
          lastNode.focus();
        }
      } else {
        if (document.activeElement === lastNode) {
          e.preventDefault();
          firstNode.focus();
        }
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      if (addedTabIndex) {
        el.removeAttribute("tabindex");
      }
      // Restore focus on unmount (e.g. dialog body unmounts while active=true).
      // The `active === false` branch above handles the toggle-to-false case and
      // clears previousFocusRef — so we guard here to restore exactly once.
      if (previousFocusRef.current) {
        previousFocusRef.current.focus();
        previousFocusRef.current = null;
      }
    };
    // ref identity is stable (RefObject); only re-run when active changes.
  }, [active]);
}
