"use client";

import React, { FormEvent, useState, useEffect } from "react";
import { CircleNotch } from "@phosphor-icons/react";
import type { AssistantStockDraftState, AssistantStockDraftItem } from "../../lib/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface AssistantStockDraftProps {
  assistantStockDraft: AssistantStockDraftState;
  setAssistantStockDraft: (value: AssistantStockDraftState | null) => void;
  assistantStockSaving: boolean;
  assistantStockError: string | null;
  setAssistantStockError: (value: string | null) => void;
  handleAssistantStockSubmit: (event: FormEvent<HTMLFormElement>) => void;
  updateAssistantStockField: (field: "supplierName", value: string) => void;
  updateAssistantStockItem: (index: number, field: keyof AssistantStockDraftItem, value: string) => void;
  onDismiss: () => void;
  t: (en: string, es: string) => string;
}

// eslint-disable-next-line max-lines-per-function -- composition root for the stock draft form
export function AssistantStockDraft({
  assistantStockDraft,
  assistantStockSaving,
  assistantStockError,
  handleAssistantStockSubmit,
  updateAssistantStockField,
  updateAssistantStockItem,
  onDismiss,
  t,
}: AssistantStockDraftProps) {
  const hasSupplier = assistantStockDraft.supplierName.trim().length > 0;
  const [createPurchaseRequest, setCreatePurchaseRequest] = useState(hasSupplier);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  // When supplier name is cleared, uncheck purchase request
  useEffect(() => {
    if (!hasSupplier) setCreatePurchaseRequest(false);
    else setCreatePurchaseRequest(true);
  }, [hasSupplier]);

  // Reset confirmation UI when the draft itself is replaced (e.g. a new stock
  // draft arrives while the discard prompt is showing).
  useEffect(() => {
    setConfirmDiscard(false);
  }, [assistantStockDraft]);

  return (
    <div
      role="status"
      aria-live="polite"
      className="w-full"
      style={{ borderRadius: "var(--radius-xl)", overflow: "hidden", backgroundColor: "var(--surface)", border: "1px solid var(--border)" }}
    >
    <div
      className="assistant-panel w-full p-5"
      style={{ borderTopLeftRadius: 0, borderBottomLeftRadius: 0 }}
    >
      <p className="text-caption" style={{ fontFamily: "var(--font-dm-sans)", color: "var(--tone-body)", marginBottom: "1rem" }}>
        {t("Review the data and confirm the upload.", "Revisá los datos y confirmá la carga.")}
      </p>

      <form onSubmit={(event) => void handleAssistantStockSubmit(event)} className="flex flex-col gap-2">
        <Input
          type="text"
          value={assistantStockDraft.supplierName}
          onChange={(e) => updateAssistantStockField("supplierName", e.target.value)}
          placeholder={t("Supplier (optional)", "Proveedor (opcional)")}
          style={{ fontFamily: "var(--font-dm-sans)", minHeight: "44px" }}
        />

        {/* Purchase request disclosure — shown only when supplier is named */}
        {hasSupplier && (
          <label
            className="flex items-center gap-2 rounded-lg px-3 py-2 cursor-pointer"
            style={{ backgroundColor: "var(--surface-subtle)" }}
          >
            <input
              type="checkbox"
              name="createPurchaseRequest"
              value="true"
              checked={createPurchaseRequest}
              onChange={(e) => setCreatePurchaseRequest(e.target.checked)}
              style={{ accentColor: "var(--brand)", width: "1rem", height: "1rem", flexShrink: 0 }}
            />
            <span className="text-caption" style={{ fontFamily: "var(--font-dm-sans)", color: "var(--tone-body)" }}>
              {t(
                `Create purchase request for ${assistantStockDraft.supplierName}`,
                `Crear solicitud de compra para ${assistantStockDraft.supplierName}`
              )}
            </span>
          </label>
        )}

        {/* Hidden input carries the value when checkbox is hidden (no supplier) */}
        {!hasSupplier && (
          <input type="hidden" name="createPurchaseRequest" value="false" />
        )}

        {assistantStockDraft.items.map((item, idx) => (
          <div key={idx} className="grid gap-3 md:grid-cols-3">
            <Input
              type="text"
              value={item.itemName}
              onChange={(e) => updateAssistantStockItem(idx, "itemName", e.target.value)}
              placeholder={t("Item name", "Nombre del ítem")}
              style={{ fontFamily: "var(--font-dm-sans)", minHeight: "44px" }}
            />
            <div className="relative">
              <Input
                type="number"
                inputMode="numeric"
                min="0"
                value={item.quantity}
                onChange={(e) => updateAssistantStockItem(idx, "quantity", e.target.value)}
                placeholder={t("Quantity", "Cantidad")}
                style={{ fontFamily: "var(--font-dm-sans)", minHeight: "44px", paddingRight: "3rem" }}
              />
              <span style={{ position: "absolute", right: "0.75rem", top: "50%", transform: "translateY(-50%)", color: "var(--tone-muted)", fontSize: "0.875rem", pointerEvents: "none", userSelect: "none" }}>u.</span>
            </div>
            <div className="relative">
              <span style={{ position: "absolute", left: "0.6rem", top: "50%", transform: "translateY(-50%)", color: "var(--tone-muted)", fontSize: "0.875rem", pointerEvents: "none", userSelect: "none" }}>$</span>
              <Input
                type="number"
                inputMode="decimal"
                min="0"
                step="0.01"
                value={item.unitPrice}
                onChange={(e) => updateAssistantStockItem(idx, "unitPrice", e.target.value)}
                placeholder={t("Unit price (ARS)", "Precio unit. (ARS)")}
                style={{ fontFamily: "var(--font-dm-sans)", minHeight: "44px", paddingLeft: "1.5rem" }}
              />
            </div>
          </div>
        ))}

        {assistantStockError && (
          <p className="text-caption" style={{ fontFamily: "var(--font-dm-sans)", color: "var(--danger)" }}>
            {assistantStockError}
          </p>
        )}

        <div className="flex flex-wrap gap-2 mt-1">
          {/* Explicit action-primary-* tokens so the confirm button stays visible on the dark
              .assistant-panel (rgba navy bg). --primary resolves to navy there → invisible. */}
          <Button
            type="submit"
            disabled={assistantStockSaving}
            className="rounded-full"
            style={{ fontFamily: "var(--font-dm-sans)", minHeight: "44px", backgroundColor: "var(--action-primary-bg)", color: "var(--action-primary-fg)" }}
          >
            {assistantStockSaving
              ? <><CircleNotch className="icon-sm animate-spin" aria-hidden />{" "}{t("Saving...", "Guardando...")}</>
              : t("Confirm upload", "Confirmar carga")}
          </Button>
          {confirmDiscard ? (
            <>
              <Button
                type="button"
                onClick={onDismiss}
                variant="destructive"
                className="rounded-full"
                style={{ fontFamily: "var(--font-dm-sans)", minHeight: "44px" }}
              >
                {t("Yes, discard", "Sí, eliminar")}
              </Button>
              {/* tone-on-brand-muted: cream at 75% opacity — WCAG AA 4.5:1+ on dark navy */}
              <Button
                type="button"
                onClick={() => setConfirmDiscard(false)}
                variant="ghost"
                className="rounded-full"
                style={{ fontFamily: "var(--font-dm-sans)", minHeight: "44px", color: "var(--tone-on-brand-muted)" }}
              >
                {t("Cancel", "Cancelar")}
              </Button>
            </>
          ) : (
            <Button
              type="button"
              onClick={() => setConfirmDiscard(true)}
              variant="ghost"
              className="rounded-full"
              style={{ fontFamily: "var(--font-dm-sans)", minHeight: "44px", color: "var(--tone-on-brand-muted)" }}
            >
              {t("Discard upload", "Eliminar carga")}
            </Button>
          )}
        </div>
      </form>
    </div>
    </div>
  );
}
