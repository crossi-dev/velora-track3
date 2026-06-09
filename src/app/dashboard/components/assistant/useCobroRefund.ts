"use client";

// Hook que aísla la lógica de devolución cash V1 (slice 5) de la card del
// Cobro QR. Vive en sibling para preservar el hard limit de 300 LOC en
// `AssistantCobroQrDraft.tsx`.
//
// Flujo:
//   1. status="confirmed" → user clickea "Devolver" → status="refund-prompt".
//   2. status="refund-prompt" → user confirma → status="refunding" + POST.
//   3. status="refunded" tras OK del server. La card se queda visible para
//      mantener el audit trail (no auto-dismiss como en confirm).
//   4. Errores: vuelven a status="confirmed" con errorMessage seteado.

import { useCallback } from "react";
import type { CobroQrDraftState } from "../../lib/types";
import { buildMutationHeaders, fetchWithTimeout, getSafeJson } from "../../lib/hooks/utils";

interface RefundResponseBody {
  ok?: boolean;
  paymentIntentId?: string;
  refundedAt?: string;
  code?: string;
  message?: string;
}

export interface UseCobroRefundArgs {
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

export interface UseCobroRefundResult {
  startPrompt: () => void;
  cancelPrompt: () => void;
  doRefund: () => Promise<void>;
}

export function useCobroRefund(args: UseCobroRefundArgs): UseCobroRefundResult {
  const { draft, setDraft, appendChatHistoryEntry, loadBusiness, t, moneyFmt } = args;

  const startPrompt = useCallback(() => {
    if (draft.status !== "confirmed") return;
    setDraft({ ...draft, status: "refund-prompt", errorMessage: null });
  }, [draft, setDraft]);

  const cancelPrompt = useCallback(() => {
    if (draft.status !== "refund-prompt") return;
    setDraft({ ...draft, status: "confirmed", errorMessage: null });
  }, [draft, setDraft]);

  const doRefund = useCallback(async () => {
    if (draft.status !== "refund-prompt") return;
    setDraft({ ...draft, status: "refunding", errorMessage: null });
    try {
      // Slice 6 — la firma DEBE ser estable por intent (sin Date.now())
      // para que `getOrCreateMutationKey` reutilice el mismo
      // X-Idempotency-Key en retries de red. Server-side
      // `beginIdempotentMutation` cachea la respuesta del primer refund;
      // un retry tras red intermitente devuelve el body cacheado en lugar
      // de duplicar el cash-movement negativo. Igual patrón que el
      // confirm en AssistantCobroQrDraft.tsx.
      const signature = `payment_intent.refund:${draft.paymentIntentId}`;
      const response = await fetchWithTimeout("/api/payment-intents/refund", {
        method: "POST",
        headers: buildMutationHeaders(signature),
        body: JSON.stringify({ paymentIntentId: draft.paymentIntentId }),
      });
      const data = await getSafeJson<RefundResponseBody>(
        response,
        t("Could not refund the charge.", "No pude devolver el cobro."),
      );
      if (!response.ok) {
        const errMsg =
          data?.message ??
          t("Could not refund the charge.", "No pude devolver el cobro.");
        // Volvemos a confirmed (estado válido) con error inline.
        setDraft({ ...draft, status: "confirmed", errorMessage: errMsg });
        appendChatHistoryEntry("error", errMsg);
        return;
      }
      setDraft({
        ...draft,
        status: "refunded",
        errorMessage: null,
        refundedAt: data?.refundedAt ?? new Date().toISOString(),
      });
      const okMsg = t(
        `Refunded ${moneyFmt(draft.monto)} in cash.`,
        `Devolví ${moneyFmt(draft.monto)} en efectivo.`,
      );
      appendChatHistoryEntry("success", okMsg);
      await loadBusiness({ silent: true, force: true }).catch(() => {});
    } catch {
      const errMsg = t(
        "Could not refund the charge. Try again.",
        "No pude devolver el cobro. Intentá de nuevo.",
      );
      setDraft({ ...draft, status: "confirmed", errorMessage: errMsg });
      appendChatHistoryEntry("error", errMsg);
    }
  }, [draft, setDraft, appendChatHistoryEntry, loadBusiness, t, moneyFmt]);

  return { startPrompt, cancelPrompt, doRefund };
}
