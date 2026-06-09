"use client";

// Slice 6 — post-confirm CTA row for the Cobro QR confirmed card.
// Two actions rendered inline below the "Cobrado $X" block:
//
//   "Mandar comprobante" — POST to /api/invoices/{invoiceId}/send-whatsapp.
//     Visibility: invoiceId && customerHasPhone === true (both required).
//     After success: button fades to "Comprobante enviado" inline chip.
//     On error: alert with server message or fallback copy.
//
//   "Listo" — always rendered.
//     Tapping dismisses the card via onDismiss?.() and disables the button.

import React, { useState } from "react";
import { CircleNotch, PaperPlaneTilt, CheckFat } from "@phosphor-icons/react";
import type { CobroQrDraftState } from "../../lib/types";
import { executeDashboardAction } from "../../lib/actions/executeDashboardAction";

interface PostConfirmActionsProps {
  draft: CobroQrDraftState;
  onDismiss?: () => void;
  t: (en: string, es: string) => string;
}

export function PostConfirmActions({ draft, onDismiss, t }: PostConfirmActionsProps) {
  const [sendingWa, setSendingWa] = useState(false);
  const [waSent, setWaSent] = useState(false);
  const [done, setDone] = useState(false);
  const [waError, setWaError] = useState<string | null>(null);

  const canSendReceipt =
    typeof draft.invoiceId === "string" &&
    draft.invoiceId.length > 0 &&
    draft.customerHasPhone === true;

  const handleSendReceipt = async () => {
    if (sendingWa || waSent || !draft.invoiceId) return;
    setSendingWa(true);
    try {
      await executeDashboardAction("invoice.send-whatsapp", {
        invoiceId: draft.invoiceId,
        phone: null,
      });
      setWaSent(true);
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : t(
              "Could not send the receipt. Try again.",
              "No se pudo enviar el comprobante. Probá de nuevo.",
            );
      setWaError(msg);
      setTimeout(() => setWaError(null), 5000);
    } finally {
      setSendingWa(false);
    }
  };

  const handleDone = () => {
    setDone(true);
    onDismiss?.();
  };

  return (
    <div className="flex flex-col gap-2">
    {waError && (
      <p
        className="text-caption"
        style={{ color: "var(--danger)", margin: 0, lineHeight: 1.5 }}
        role="alert"
      >
        {waError}
      </p>
    )}
    <div className="flex flex-row gap-2 flex-wrap">
      {/* "Mandar comprobante" — conditional */}
      {canSendReceipt && !waSent && (
        <button
          type="button"
          disabled={sendingWa || done}
          onClick={() => { void handleSendReceipt(); }}
          className="flex-1 rounded-full px-4 py-2.5 font-semibold disabled:opacity-50"
          style={{
            fontFamily: "var(--font-dm-sans)",
            backgroundColor: "var(--brand-deep, var(--action-primary-bg))",
            color: "var(--action-primary-fg, white)",
            minHeight: "44px",
            fontSize: "0.9375rem",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: "0.4rem",
          }}
        >
          {sendingWa ? (
            <CircleNotch className="icon-sm animate-spin" aria-hidden />
          ) : (
            <PaperPlaneTilt weight="fill" className="icon-sm" aria-hidden />
          )}
          {sendingWa
            ? t("Sending...", "Enviando...")
            : t("Send receipt", "Mandar comprobante")}
        </button>
      )}

      {/* Inline sent confirmation */}
      {waSent && (
        <span
          className="flex-1 flex items-center justify-center gap-1.5 rounded-full px-4 py-2.5"
          style={{
            fontFamily: "var(--font-dm-sans)",
            fontSize: "0.9375rem",
            color: "var(--success)",
            backgroundColor: "var(--success-soft)",
            minHeight: "44px",
          }}
        >
          <PaperPlaneTilt weight="fill" className="icon-sm" aria-hidden />
          {t("Receipt sent", "Comprobante enviado")}
        </span>
      )}

      {/* "Listo" — always shown */}
      <button
        type="button"
        disabled={done}
        onClick={handleDone}
        className="flex-1 rounded-full px-4 py-2.5 font-semibold disabled:opacity-70"
        style={{
          fontFamily: "var(--font-dm-sans)",
          backgroundColor: done ? "var(--success-soft)" : "var(--surface-subtle)",
          color: done ? "var(--success)" : "var(--tone-muted)",
          border: "1px solid var(--bubble-border)",
          minHeight: "44px",
          fontSize: "0.9375rem",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: "0.4rem",
        }}
      >
        <CheckFat weight={done ? "fill" : "regular"} className="icon-sm" aria-hidden />
        {done ? t("Done ✓", "Listo ✓") : t("Done", "Listo")}
      </button>
    </div>
    </div>
  );
}
