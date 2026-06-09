"use client";

import { useEffect } from "react";
import type React from "react";
import { CHAT_EVENT } from "../chat-events";

// Voice-trained catalog flow: useAssistantConfirmation dispatches
// "velora:retry-sale" after product.create finishes, carrying the original
// sale text. Re-dispatching through handleGo makes the parser resolve the
// newly-created product and continue the sale.
export function useRetrySaleListener(
  handleGoRef: React.MutableRefObject<
    (text?: string, continueAssistantQuestion?: boolean, replayKey?: string) => Promise<unknown>
  >,
) {
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onRetrySale = (ev: Event) => {
      const detail = (ev as CustomEvent<{ saleText?: unknown }>).detail;
      const saleText = typeof detail?.saleText === "string" ? detail.saleText : null;
      if (!saleText) return;
      void handleGoRef.current(saleText, false);
    };
    window.addEventListener(CHAT_EVENT.RETRY_SALE, onRetrySale as EventListener);
    return () => window.removeEventListener(CHAT_EVENT.RETRY_SALE, onRetrySale as EventListener);
  }, [handleGoRef]);
}
