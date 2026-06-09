"use client";

// Card del módulo Cobro QR.
//
// Renderiza una de dos UX según `draft.metodo`:
//   - "qr"    → QR placeholder + monto + botón "Marcar cobrado".
//   - "alias" → alias MP/CVU del dueño en grande + monto + copy + botón
//               "Marcar cobrado". Slice 2 — "modo informal" sin API externa.
//
// Las dos vistas viven en `AssistantCobroQrDraft.views.tsx` para preservar
// el hard limit de 300 LOC en este archivo.
//
// Click en "Marcar cobrado" dispara el confirm contra /api/payment-intents/confirm.
// Mientras el POST está in-flight la card pasa a estado "confirming"; tras OK
// se reemplaza por la confirmación "✓ Cobrado $X" y la card se desmonta sola.

import React, { useCallback, useRef, useState } from "react"; // useCallback needed for handleCopyAlias
import { CircleNotch } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import type { CobroQrDraftState } from "../../lib/types";
import { CobroQrView, CobroAliasView, CountdownPill } from "./AssistantCobroQrDraft.views";
import { CobroConfirmedView } from "./AssistantCobroQrDraft.confirmed";
import { useCobroExpiryCountdown } from "./useCobroExpiryCountdown";
import { useCobroAutoConfirm } from "./useCobroAutoConfirm";
import { useCobroRefund } from "./useCobroRefund";
import { useCobroScrollIntoView } from "./useCobroScrollIntoView";
import { useCobroEnrichedStatus } from "./useCobroEnrichedStatus";
import { useCobroActions } from "./useCobroActions";

interface AssistantCobroQrDraftProps {
  draft: CobroQrDraftState;
  setDraft: (next: CobroQrDraftState | null) => void;
  appendChatHistoryEntry: (
    kind: "user" | "reply" | "success" | "error",
    text: string,
  ) => void;
  loadBusiness: (opts?: { silent?: boolean }) => Promise<void>;
  moneyFmt: (n: number) => string;
  t: (en: string, es: string) => string;
}

export function AssistantCobroQrDraft({
  draft,
  setDraft,
  appendChatHistoryEntry,
  loadBusiness,
  moneyFmt,
  t,
}: AssistantCobroQrDraftProps) {
  const [aliasCopied, setAliasCopied] = useState(false);
  const cardRef = useRef<HTMLDivElement | null>(null);
  // Auto-scroll al QR card cuando el cobro recién se genera. Ver useCobroScrollIntoView.ts.
  useCobroScrollIntoView(cardRef, draft.status);

  // Slice 3 — countdown 2 min. Si pasa a 0:00 marcamos el draft "expired";
  // el botón "Marcar cobrado" queda disabled y la card muestra el CTA para
  // generar uno nuevo.
  const expiry = useCobroExpiryCountdown(draft.expiresAt, {
    onExpire: () => {
      if (draft.status === "pending") {
        setDraft({ ...draft, status: "expired", errorMessage: null });
      }
    },
  });

  // Confirm + dismiss logic extracted to preserve 300-line limit. Ver useCobroActions.ts.
  const { handleConfirm, handleDismiss } = useCobroActions({
    draft,
    setDraft,
    appendChatHistoryEntry,
    loadBusiness,
    moneyFmt,
    t,
    expiryExpired: expiry.expired,
  });

  // Webhook MP confirma el intent en DB; auto-confirm flipea la card sin
  // requerir click manual. La lógica vive en useCobroAutoConfirm para
  // preservar el límite de 300 LOC en este archivo.
  useCobroAutoConfirm({ draft, setDraft, appendChatHistoryEntry, loadBusiness, t, moneyFmt });

  const handleCopyAlias = useCallback(async () => {
    if (!draft.alias) return;
    try {
      await navigator.clipboard.writeText(draft.alias);
      setAliasCopied(true);
      setTimeout(() => setAliasCopied(false), 1400);
    } catch {
      // Clipboard puede fallar por permisos — silencioso, el alias se ve grande igual.
    }
  }, [draft.alias]);

  // Slice 5 — la card permanece montada tras el confirm para permitir el flujo
  // de devolución. `isPostConfirm` cubre todos los estados terminales/intermedios
  // del refund flow.
  const isPostConfirm =
    draft.status === "confirmed" ||
    draft.status === "refund-prompt" ||
    draft.status === "refunding" ||
    draft.status === "refunded";
  const isConfirming = draft.status === "confirming";
  const isCancelling = draft.status === "cancelling";
  const isAlias = draft.metodo === "alias";
  // Slice 3 — el draft puede estar marcado expired por status local (countdown
  // hit 0:00) o por respuesta del server (410 GONE). Cualquiera bloquea el CTA.
  const isExpired = draft.status === "expired" || expiry.expired;
  const confirmDisabled = isConfirming || isExpired;

  const refund = useCobroRefund({ draft, setDraft, appendChatHistoryEntry, loadBusiness, t, moneyFmt });
  // Slice 6 — enriched status (invoiceId + customerHasPhone) after confirm. Ver useCobroEnrichedStatus.ts.
  useCobroEnrichedStatus({ draft, setDraft });

  return (
    <div ref={cardRef} className="w-full" style={{ borderRadius: "var(--radius-xl)", overflow: "hidden" }}>
      <div
        className="assistant-panel w-full p-5"
        style={{
          backgroundColor: "var(--surface)",
          border: "1px solid var(--border)",
        }}
      >
        {isPostConfirm ? (
          <CobroConfirmedView
            draft={draft}
            errorMessage={draft.errorMessage}
            onStartRefundPrompt={refund.startPrompt}
            onConfirmRefund={refund.doRefund}
            onCancelRefundPrompt={refund.cancelPrompt}
            onDismiss={() => setDraft(null)}
            moneyFmt={moneyFmt}
            t={t}
          />
        ) : (
          <>
            {isAlias ? (
              <CobroAliasView
                alias={draft.alias ?? ""}
                monto={draft.monto}
                customerName={draft.customerName}
                aliasCopied={aliasCopied}
                onCopy={handleCopyAlias}
                moneyFmt={moneyFmt}
                t={t}
              />
            ) : (
              <CobroQrView
                qrPlaceholderUrl={draft.qrPlaceholderUrl}
                monto={draft.monto}
                customerName={draft.customerName}
                sandbox={draft.sandbox}
                moneyFmt={moneyFmt}
                t={t}
              />
            )}

            <div className="mt-3">
              <CountdownPill
                expired={isExpired}
                label={expiry.label}
                hasTimeout={expiry.hasTimeout}
                t={t}
              />
            </div>

            {draft.errorMessage && !isExpired && (
              <p
                className="text-caption mt-3"
                style={{ fontFamily: "var(--font-dm-sans)", color: "var(--danger)", textAlign: "center" }}
              >
                {draft.errorMessage}
              </p>
            )}

            <div className="mt-4 flex flex-col gap-2 md:flex-row">
              <Button
                type="button"
                onClick={handleConfirm}
                disabled={confirmDisabled}
                className="flex-1 rounded-full"
                style={{ fontFamily: "var(--font-dm-sans)", minHeight: "44px", backgroundColor: "var(--action-primary-bg)", color: "var(--action-primary-fg)" }}
              >
                {isConfirming ? (
                  <>
                    <CircleNotch className="icon-sm animate-spin" aria-hidden />{" "}
                    {t("Confirming...", "Confirmando...")}
                  </>
                ) : isExpired ? (
                  t("Expired", "Expirado")
                ) : (
                  t("Mark as charged", "Marcar cobrado")
                )}
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={handleDismiss}
                disabled={isConfirming || isCancelling}
                className="flex-1 rounded-full"
                style={{ fontFamily: "var(--font-dm-sans)", minHeight: "44px", color: "var(--tone-muted)" }}
              >
                {isCancelling ? (
                  <>
                    <CircleNotch className="icon-sm animate-spin" aria-hidden />{" "}
                    {t("Cancelling...", "Cancelando...")}
                  </>
                ) : (
                  t("Cancel", "Cancelar")
                )}
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
