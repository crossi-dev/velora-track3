"use client";

import React, { useRef } from "react";
import { CircleNotch } from "@phosphor-icons/react";
import type { AssistantConfirmationRequest } from "../../lib/types";
import { useFocusTrap } from "../../lib/hooks/useFocusTrap";
import { Button } from "@/components/ui/button";

interface AssistantConfirmationProps {
  assistantConfirmationRequest: AssistantConfirmationRequest;
  assistantConfirmationSubmitting: boolean;
  assistantConfirmationError: string | null;
  handleAssistantConfirmationConfirm: () => void;
  handleAssistantConfirmationCancel: () => void;
  t: (en: string, es: string) => string;
}

export function AssistantConfirmation({
  assistantConfirmationRequest,
  assistantConfirmationSubmitting,
  assistantConfirmationError,
  handleAssistantConfirmationConfirm,
  handleAssistantConfirmationCancel,
  t,
}: AssistantConfirmationProps) {
  const isCritical = assistantConfirmationRequest.severity === "critical";
  const titleId = "assistant-confirmation-title";
  const primaryBtnRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  // Pass primaryBtnRef as initialFocusRef so the trap moves focus directly to
  // the primary action button — no separate useEffect needed (and no fight
  // between two competing focus calls).
  useFocusTrap(dialogRef, true, primaryBtnRef);

  return (
    <div
      ref={dialogRef}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby={titleId}
      className="w-full"
      style={{ borderRadius: "var(--radius-xl)", overflow: "hidden" }}
    >
    <div
      className="assistant-panel w-full p-5"
      style={{
        backgroundColor: isCritical ? "var(--danger-soft)" : "var(--warning-soft)",
        borderTopLeftRadius: 0,
        borderBottomLeftRadius: 0,
      }}
    >
      <p
        id={titleId}
        className="text-caption"
        style={{
          fontFamily: "var(--font-dm-sans)",
          fontWeight: 700,
          color: isCritical ? "var(--danger)" : "var(--warning)",
        }}
      >
        {assistantConfirmationRequest.title}
      </p>
      <p
        className="mt-2"
        style={{
          fontFamily: "var(--font-dm-sans)",
          fontSize: "1rem",
          color: "var(--tone-body)",
          lineHeight: 1.5,
          whiteSpace: "pre-wrap",
        }}
      >
        {assistantConfirmationRequest.message}
      </p>

      {assistantConfirmationError && (
        <p
          className="text-caption mt-3"
          style={{
            fontFamily: "var(--font-dm-sans)",
            color: "var(--danger)",
          }}
        >
          {assistantConfirmationError}
        </p>
      )}

      <div className="mt-4 flex flex-col gap-2 md:flex-row">
        <Button
          ref={primaryBtnRef}
          type="button"
          onClick={handleAssistantConfirmationConfirm}
          disabled={assistantConfirmationSubmitting}
          variant={isCritical ? "destructive" : "default"}
          className="flex-1 rounded-full"
          style={{ minHeight: "44px", fontFamily: "var(--font-dm-sans)" }}
        >
          {assistantConfirmationSubmitting
            ? <><CircleNotch className="icon-sm animate-spin" aria-hidden />{" "}{t("Confirming...", "Confirmando...")}</>
            : assistantConfirmationError
              ? t("Retry", "Reintentar")
              : assistantConfirmationRequest.confirmLabel}
        </Button>
        <Button
          type="button"
          onClick={handleAssistantConfirmationCancel}
          disabled={assistantConfirmationSubmitting}
          variant="ghost"
          className="flex-1 rounded-full"
          style={{ minHeight: "44px", fontFamily: "var(--font-dm-sans)", color: "var(--tone-muted)" }}
        >
          {assistantConfirmationRequest.cancelLabel}
        </Button>
      </div>
    </div>
    </div>
  );
}
