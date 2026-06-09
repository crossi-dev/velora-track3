"use client";

// Confirm and dismiss action handlers for the Cobro QR card.
// Extracted to keep AssistantCobroQrDraft.tsx under the 300-line hard limit.

import { useCallback } from "react";
import type { CobroQrDraftState } from "../../lib/types";
import { buildMutationHeaders, fetchWithTimeout, getSafeJson } from "../../lib/hooks/utils";
import { triggerConfirmFeedback } from "../../lib/sounds/play-confirm-beep";

interface ConfirmResponseBody {
  ok?: boolean;
  paymentIntentId?: string;
  saleId?: string | null;
  code?: string;
  message?: string;
}

interface UseCobroActionsOptions {
  draft: CobroQrDraftState;
  setDraft: (next: CobroQrDraftState | null) => void;
  appendChatHistoryEntry: (kind: "user" | "reply" | "success" | "error", text: string) => void;
  loadBusiness: (opts?: { silent?: boolean; force?: boolean }) => Promise<void>;
  moneyFmt: (n: number) => string;
  t: (en: string, es: string) => string;
  expiryExpired: boolean;
}

export function useCobroActions({
  draft,
  setDraft,
  appendChatHistoryEntry,
  loadBusiness,
  moneyFmt,
  t,
  expiryExpired,
}: UseCobroActionsOptions) {
  const handleConfirm = useCallback(async () => {
    if (draft.status === "confirming" || draft.status === "confirmed") return;
    if (draft.status === "expired" || expiryExpired) return;
    setDraft({ ...draft, status: "confirming", errorMessage: null });
    try {
      const signature = `payment_intent.confirm:${draft.paymentIntentId}`;
      const response = await fetchWithTimeout("/api/payment-intents/confirm", {
        method: "POST",
        headers: buildMutationHeaders(signature),
        body: JSON.stringify({ paymentIntentId: draft.paymentIntentId }),
      });
      const data = await getSafeJson<ConfirmResponseBody>(
        response,
        t("Could not confirm the charge.", "No pude confirmar el cobro."),
      );
      if (!response.ok) {
        // 409 ALREADY_CONFIRMED: webhook MP confirmó antes que el click manual
        if (response.status === 409 && data?.code === "ALREADY_CONFIRMED") {
          setDraft({ ...draft, status: "confirmed", errorMessage: null });
          triggerConfirmFeedback();
          appendChatHistoryEntry("success", t(`Done, ${moneyFmt(draft.monto)} charged.`, `Listo, registré el cobro de ${moneyFmt(draft.monto)}.`));
          await loadBusiness({ silent: true, force: true }).catch(() => {});
          return;
        }
        const errMsg = data?.message ?? t("Could not confirm the charge.", "No pude confirmar el cobro.");
        // Slice 3 — 410 GONE = expirado
        const nextStatus = response.status === 410 || data?.code === "EXPIRED" ? "expired" : "error";
        setDraft({ ...draft, status: nextStatus, errorMessage: errMsg });
        appendChatHistoryEntry("error", errMsg);
        return;
      }
      setDraft({ ...draft, status: "confirmed", errorMessage: null });
      // Slice 4 — beep + haptic (PRD §4): "ka-ching" cultural AR. Best-effort.
      triggerConfirmFeedback();
      appendChatHistoryEntry("success", t(`Done, ${moneyFmt(draft.monto)} charged.`, `Listo, registré el cobro de ${moneyFmt(draft.monto)}.`));
      await loadBusiness({ silent: true }).catch(() => {});
      // Slice 5 — card stays mounted for refund flow.
    } catch {
      const errMsg = t("Could not confirm the charge. Try again.", "No pude confirmar el cobro. Intentá de nuevo.");
      setDraft({ ...draft, status: "error", errorMessage: errMsg });
      appendChatHistoryEntry("error", errMsg);
    }
  }, [draft, setDraft, appendChatHistoryEntry, loadBusiness, t, expiryExpired, moneyFmt]);

  const handleDismiss = useCallback(async () => {
    if (draft.status === "confirming" || draft.status === "cancelling") return;
    // For a pending intent, cancel in DB before hiding the card.
    if (draft.status === "pending" || draft.status === "error") {
      setDraft({ ...draft, status: "cancelling", errorMessage: null });
      try {
        const signature = `payment_intent.cancel:${draft.paymentIntentId}`;
        const res = await fetchWithTimeout("/api/payment-intents/cancel", {
          method: "POST",
          headers: buildMutationHeaders(signature),
          body: JSON.stringify({ paymentIntentId: draft.paymentIntentId }),
        });
        if (!res.ok) {
          // Server rejected the cancel — log and leave the card visible so the
          // intent is not orphaned. Non-blocking: no modal, just a console warn.
          console.warn(`[useCobroActions] cancel returned ${res.status}; card left open to avoid orphan payment intent.`);
          setDraft({ ...draft, status: "error", errorMessage: t("Could not cancel. Try again.", "No pude cancelar. Intentá de nuevo.") });
          return;
        }
      } catch {
        // Network error — swallow and still dismiss.
      }
    }
    setDraft(null);
  }, [draft, setDraft, t]);

  return { handleConfirm, handleDismiss };
}
