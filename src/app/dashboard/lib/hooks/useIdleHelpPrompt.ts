"use client";

import { useEffect, useRef } from "react";

// Event name for the T1 idle nudge — dispatched when the owner hasn't
// interacted for IDLE_MS milliseconds while the T1 welcome is visible.
export const IDLE_HELP_PROMPT_EVENT = "velora:idle-help-prompt-t1";

const IDLE_MS = 45_000;

interface UseIdleHelpPromptOptions {
  /** True only while the T1 welcome ("¿Cómo se llama tu negocio?") is the
   *  last visible message and the owner hasn't responded yet. */
  enabled: boolean;
  /** Ref exposing a `reset()` function. Call it on each user interaction
   *  (keydown on input, chip click) to restart the idle timer. Wire it to
   *  textarea onChange and chip onClick in the parent component. */
  resetRef: React.MutableRefObject<() => void>;
}

/**
 * Fires `velora:idle-help-prompt-t1` on window after 45 s of inactivity
 * while `enabled` is true. Parent component listens and renders the chip.
 *
 * Design: timer lives here, chip render lives in the parent. Decoupled via
 * CustomEvent so the hook stays pure (no direct DOM or JSX output).
 */
export function useIdleHelpPrompt({ enabled, resetRef }: UseIdleHelpPromptOptions): void {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clear = () => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const start = () => {
    clear();
    timerRef.current = setTimeout(() => {
      window.dispatchEvent(new CustomEvent(IDLE_HELP_PROMPT_EVENT));
    }, IDLE_MS);
  };

  // Expose reset so parent can cancel the timer on any interaction.
  resetRef.current = () => {
    if (enabled) start();
    else clear();
  };

  useEffect(() => {
    if (!enabled) {
      clear();
      return;
    }
    start();
    return clear;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);
}
