"use client";

// Slice 6 — enriches the draft with invoiceId + customerHasPhone once the
// card flips to "confirmed". Fires a single GET to /api/payment-intents/status
// to get the invoice data so the "Mandar comprobante" CTA can appear.
//
// Deliberately kept separate from useCobroStatusPoll (which stops polling on
// confirm) — this is a one-shot fetch after the transition, not polling.

import { useEffect, useRef } from "react";
import type { CobroQrDraftState } from "../../lib/types";

interface EnrichedStatusResponse {
  invoiceId?: string | null;
  customerHasPhone?: boolean | null;
}

interface UseCobroEnrichedStatusInput {
  draft: CobroQrDraftState;
  setDraft: (next: CobroQrDraftState | null) => void;
}

export function useCobroEnrichedStatus({ draft, setDraft }: UseCobroEnrichedStatusInput): void {
  // Keep a ref to the latest draft so the async callback never reads stale state.
  const draftRef = useRef(draft);
  draftRef.current = draft;

  useEffect(() => {
    if (draft.status !== "confirmed") return;
    if (draft.invoiceId !== undefined) return; // already loaded (null = no invoice)
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(
          `/api/payment-intents/status?id=${encodeURIComponent(draft.paymentIntentId)}`,
          { credentials: "same-origin" },
        );
        if (!res.ok || cancelled) return;
        const body = (await res.json()) as EnrichedStatusResponse;
        if (cancelled) return;
        // Spread from draftRef.current to avoid stale closure over draft.
        setDraft({
          ...draftRef.current,
          invoiceId: body.invoiceId ?? null,
          customerHasPhone: body.customerHasPhone ?? null,
        });
      } catch {
        // Non-critical — button simply won't appear if fetch fails.
      }
    })();
    return () => { cancelled = true; };
  }, [draft.status, draft.paymentIntentId]);
}
