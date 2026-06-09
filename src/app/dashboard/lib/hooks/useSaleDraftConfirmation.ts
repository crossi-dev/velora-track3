"use client";

import { useRef, useCallback } from "react";
import { buildEditableSaleText } from "./utils";
import type {
  ChatHistoryEntry,
  ParsedSale,
} from "../types";
import type {
  SaleOrchestrationActionKey,
  SaleOrchestrationPayload,
  SaleOrchestrationResult,
  SaleDraftSource,
} from "../actions/contracts";

/* ------------------------------------------------------------------ */
/*  Options                                                           */
/* ------------------------------------------------------------------ */

export interface UseSaleDraftConfirmationOptions {
  setInput: (value: string) => void;
  t: (en: string, es: string) => string;
  appendChatHistoryEntry: (kind: ChatHistoryEntry["kind"], text: string) => void;

  /* From parsing sub-hook */
  parsed: ParsedSale | null;
  openSharedSaleDraft: (draft: ParsedSale, source?: SaleDraftSource) => void;
  clearSharedSaleDraft: () => void;

  /* From execution sub-hook */
  runSaleConfirmFlow: (
    sendWhatsapp: boolean,
    preOpenedWindow?: Window | null,
    draftOverride?: ParsedSale | null
  ) => Promise<{ ok: boolean; invoiceId?: string | null }>;
}

/* ------------------------------------------------------------------ */
/*  Hook                                                              */
/* ------------------------------------------------------------------ */

export function useSaleDraftConfirmation(opts: UseSaleDraftConfirmationOptions) {
  const {
    parsed,
    openSharedSaleDraft,
    clearSharedSaleDraft,
    runSaleConfirmFlow,
    appendChatHistoryEntry,
    t,
  } = opts;

  // Keep a ref to runSaleConfirmFlow so dispatchSaleAction's useCallback never
  // captures a stale closure over `parsed` or other frequently-changing values.
  const runSaleConfirmFlowRef = useRef(runSaleConfirmFlow);
  runSaleConfirmFlowRef.current = runSaleConfirmFlow;

  const dispatchSaleAction = useCallback(
    async <K extends SaleOrchestrationActionKey>(
      action: K,
      payload: SaleOrchestrationPayload<K>
    ): Promise<SaleOrchestrationResult<K>> => {
      switch (action) {
        case "sale.draft.open": {
          const openPayload = payload as SaleOrchestrationPayload<"sale.draft.open">;
          openSharedSaleDraft(openPayload.draft, openPayload.source ?? "assistant");
          return { ok: true } as SaleOrchestrationResult<K>;
        }
        case "sale.draft.update": {
          const updatePayload = payload as SaleOrchestrationPayload<"sale.draft.update">;
          openSharedSaleDraft(updatePayload.draft, updatePayload.source ?? "assistant");
          return { ok: true } as SaleOrchestrationResult<K>;
        }
        case "sale.draft.cancel": {
          const cancelPayload = payload as SaleOrchestrationPayload<"sale.draft.cancel">;
          clearSharedSaleDraft();
          if (cancelPayload.emitChatMessage !== false) {
            // Brief pause so the confirmation doesn't flash in the same
            // frame as the cancel action — matches the Command-Layer
            // text-reply pacing so both feel like one system.
            await new Promise((r) => setTimeout(r, 400));
            appendChatHistoryEntry("reply", t("Sale cancelled.", "Venta cancelada."));
          }
          return { ok: true } as SaleOrchestrationResult<K>;
        }
        case "sale.confirm": {
          const result = await runSaleConfirmFlowRef.current(false);
          return result as SaleOrchestrationResult<K>;
        }
        case "sale.confirm-and-send-whatsapp": {
          const confirmPayload = payload as SaleOrchestrationPayload<"sale.confirm-and-send-whatsapp">;
          const result = await runSaleConfirmFlowRef.current(true, confirmPayload.preOpenedWindow, confirmPayload.draftOverride);
          return result as SaleOrchestrationResult<K>;
        }
        default: {
          const exhaustiveCheck: never = action;
          throw new Error(`Acción de venta no soportada: ${String(exhaustiveCheck)}`);
        }
      }
    },
    [
      appendChatHistoryEntry,
      clearSharedSaleDraft,
      openSharedSaleDraft,
      t,
    ]
  );

  async function handleConfirm() {
    await dispatchSaleAction("sale.confirm", {});
  }

  async function handleConfirmAndSendWhatsapp(preOpenedWindow?: Window | null) {
    await dispatchSaleAction("sale.confirm-and-send-whatsapp", { preOpenedWindow });
  }

  function handleEditParsedSale() {
    if (!parsed) return;
    const restored = buildEditableSaleText(parsed);
    opts.setInput(restored);
    void dispatchSaleAction("sale.draft.cancel", { emitChatMessage: false });
  }

  function handleCancelParsedSale() {
    void dispatchSaleAction("sale.draft.cancel", {});
  }

  return {
    dispatchSaleAction,
    handleConfirm,
    handleConfirmAndSendWhatsapp,
    handleEditParsedSale,
    handleCancelParsedSale,
  };
}
