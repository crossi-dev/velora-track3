"use client";

// Auto-confirm hook para la card del Cobro QR.
//
// Replica los side-effects del path manual (set "confirmed" + beep + chat
// entry + reload business) cuando el polling detecta que el webhook MP ya
// confirmó el intent en DB. Aísla esa lógica de AssistantCobroQrDraft.tsx
// para preservar el hard limit de 300 LOC.

import { useCallback } from "react";
import type { CobroQrDraftState } from "../../lib/types";
import { useCobroStatusPoll } from "./useCobroStatusPoll";
import { triggerConfirmFeedback } from "../../lib/sounds/play-confirm-beep";

interface UseCobroAutoConfirmInput {
  draft: CobroQrDraftState;
  setDraft: (next: CobroQrDraftState | null) => void;
  appendChatHistoryEntry: (
    kind: "user" | "reply" | "success" | "error",
    text: string,
  ) => void;
  loadBusiness: (opts?: { silent?: boolean; force?: boolean }) => Promise<void>;
  t: (en: string, es: string) => string;
  moneyFmt: (n: number) => string;
}

export function useCobroAutoConfirm(input: UseCobroAutoConfirmInput): void {
  const { draft, setDraft, appendChatHistoryEntry, loadBusiness, t, moneyFmt } = input;
  const onConfirmed = useCallback(() => {
    // Server is source of truth — allow transition from both "pending" and
    // "expired" (client-side timer fired before the MP webhook arrived).
    // Only skip if already in a terminal confirmed/post-confirm state.
    if (
      draft.status === "confirmed" ||
      draft.status === "refund-prompt" ||
      draft.status === "refunding" ||
      draft.status === "refunded"
    ) return;
    setDraft({ ...draft, status: "confirmed", errorMessage: null });
    triggerConfirmFeedback();
    const okMsg = t(`Done, ${moneyFmt(draft.monto)} charged.`, `Listo, registré el cobro de ${moneyFmt(draft.monto)}.`);
    appendChatHistoryEntry("success", okMsg);
    void loadBusiness({ silent: true, force: true }).catch(() => {});
  }, [draft, setDraft, appendChatHistoryEntry, loadBusiness, t, moneyFmt]);

  // Keep polling while "pending" OR "expired" — the webhook may arrive after
  // the client-side 2-min countdown fires (the race we're fixing here).
  useCobroStatusPoll({
    paymentIntentId: draft.paymentIntentId,
    enabled: draft.status === "pending" || draft.status === "expired",
    onConfirmed,
  });
}
