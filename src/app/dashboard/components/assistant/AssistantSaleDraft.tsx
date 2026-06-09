"use client";

import { useState } from "react";
import { CircleNotch } from "@phosphor-icons/react";
import type { ParsedSale } from "@/domain";
import { Button } from "@/components/ui/button";
import {
  AssistantSalePaymentMethod,
  type PaymentMethod,
} from "./AssistantSalePaymentMethod";
import { AssistantSaleDraftItems } from "./AssistantSaleDraftItems";

/** Which confirm button is in-flight. "none" means idle. */
export type ConfirmingAction = "none" | "plain" | "whatsapp";

interface AssistantSaleDraftProps {
  parsed: ParsedSale;
  setParsed: (value: ParsedSale | null) => void;
  confirming: boolean;
  confirmError: string | null;
  business: { currency: string };
  clients: { id: string; name: string }[];
  handleConfirm: () => void;
  handleConfirmAndSendWhatsapp?: () => void;
  handleEditParsedSale: () => void;
  handleCancelParsedSale: () => void;
  moneyFmt: (value: unknown, currency: string) => string;
  t: (en: string, es: string) => string;
  saleDraftRef: React.RefObject<HTMLDivElement | null>;
}

// eslint-disable-next-line max-lines-per-function -- composition root, not a logic violation
export function AssistantSaleDraft({
  parsed,
  setParsed,
  confirming,
  confirmError,
  business,
  clients,
  handleConfirm,
  handleConfirmAndSendWhatsapp,
  handleEditParsedSale,
  handleCancelParsedSale,
  moneyFmt,
  t,
  saleDraftRef,
}: AssistantSaleDraftProps) {
  // Track which button was clicked so only its spinner appears.
  // Resets to "none" whenever the parent clears `confirming`.
  const [clickedAction, setClickedAction] = useState<ConfirmingAction>("none");
  // Derive the active discriminator: if confirming is false, the action has
  // settled and we reset the local tracker. If confirming is true, honour it.
  const confirmingAction: ConfirmingAction = confirming ? clickedAction : "none";

  const [showCustomerPicker, setShowCustomerPicker] = useState(false);
  const [customerSearch, setCustomerSearch] = useState("");

  // Payment method is fully controlled by `parsed` — no local state so that
  // a new `parsed` prop always wins (stale-initializer avoidance).
  const paymentMethod: PaymentMethod = parsed.paymentMethod ?? "efectivo";

  function handlePaymentMethodChange(method: PaymentMethod) {
    setParsed({ ...parsed, paymentMethod: method });
  }

  return (
    <div ref={saleDraftRef} style={{ borderRadius: "var(--radius-xl)", overflow: "hidden", backgroundColor: "var(--surface)", border: "1px solid var(--border)" }}>
      <div className="p-4 md:p-5">
        <div className="flex items-center justify-between gap-2 mb-3">
          <div className="flex items-center gap-2">
            <span style={{ fontFamily: "var(--font-dm-sans)", fontWeight: 500, fontSize: "0.875rem", color: "var(--tone-muted)" }}>
              {parsed.customer.name}
            </span>
            {clients.length > 0 && (
              <button
                type="button"
                onClick={() => { setShowCustomerPicker((v) => !v); setCustomerSearch(""); }}
                disabled={confirmingAction !== "none"}
                className="text-caption"
                style={{ fontFamily: "var(--font-dm-sans)", fontWeight: 600, color: "var(--brand)", background: "none", border: "none", cursor: "pointer", padding: "0 4px", lineHeight: 1, minHeight: "44px" }}
              >
                {showCustomerPicker ? t("✕", "✕") : t("Change", "Cambiar")}
              </button>
            )}
          </div>
          <button
            type="button"
            onClick={handleEditParsedSale}
            disabled={confirmingAction !== "none"}
            className="text-caption"
            style={{ fontFamily: "var(--font-dm-sans)", fontWeight: 600, color: "var(--brand)", background: "none", border: "none", cursor: "pointer", padding: "0 4px", lineHeight: 1, minHeight: "44px" }}
          >
            {t("Edit", "Editar")}
          </button>
        </div>
          {showCustomerPicker && (
            <div className="mt-2 overflow-hidden rounded-xl">
              <input
                type="text"
                autoFocus
                value={customerSearch}
                onChange={(e) => setCustomerSearch(e.target.value)}
                placeholder={t("Search customer...", "Buscar cliente...")}
                className="text-caption w-full px-3 py-2 outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand)]"
                style={{ fontFamily: "var(--font-dm-sans)", backgroundColor: "var(--surface)", color: "var(--tone-strong)" }}
              />
              <div style={{ maxHeight: "180px", overflowY: "auto" }}>
                {clients
                  .filter((c) => c.name.toLowerCase().includes(customerSearch.toLowerCase()))
                  .slice(0, 20)
                  .map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => {
                        setParsed({ ...parsed, customer: { id: c.id, name: c.name } });
                        setShowCustomerPicker(false);
                        setCustomerSearch("");
                      }}
                      className="text-caption w-full text-left px-3 py-2"
                      style={{ fontFamily: "var(--font-dm-sans)", color: "var(--tone-strong)", backgroundColor: "transparent", border: "none", cursor: "pointer", display: "flex", alignItems: "center", minHeight: "44px" }}
                    >
                      {c.name}
                    </button>
                  ))}
                {(() => {
                  const all = clients.filter((c) => c.name.toLowerCase().includes(customerSearch.toLowerCase()));
                  const extra = all.length > 20 ? all.length - 20 : 0;
                  return (
                    <>
                      {all.length === 0 && (
                        <p className="text-caption px-3 py-2" style={{ fontFamily: "var(--font-dm-sans)", color: "var(--tone-muted)" }}>
                          {t("No results.", "Sin resultados.")}
                        </p>
                      )}
                      {extra > 0 && (
                        <p className="text-caption px-3 py-2" style={{ fontFamily: "var(--font-dm-sans)", color: "var(--tone-muted)" }}>
                          {t(`+${extra} more — refine your search`, `+${extra} más — refiná tu búsqueda`)}
                        </p>
                      )}
                    </>
                  );
                })()}
              </div>
            </div>
          )}
        <AssistantSaleDraftItems
          items={parsed.items ?? []}
          currency={business.currency}
          moneyFmt={moneyFmt}
          t={t}
        />
        <div className="mt-3 flex items-center justify-between">
          <span style={{ fontFamily: "var(--font-dm-sans)", fontWeight: 600, fontSize: "0.875rem", color: "var(--tone-muted)" }}>
            Total
          </span>
          <span style={{ fontFamily: "var(--font-dm-sans)", fontWeight: 700, fontSize: "1.5rem", color: "var(--action-primary-bg)" }}>
            {moneyFmt(parsed.total, business.currency)}
          </span>
        </div>

        <AssistantSalePaymentMethod
          value={paymentMethod}
          disabled={confirmingAction !== "none"}
          onChange={handlePaymentMethodChange}
          t={t}
        />

        {confirmError ? (
          <div className="mt-5 space-y-4">
              <div
                className="rounded-2xl px-4 py-4"
                style={{ 
                  backgroundColor: "var(--danger-soft)",
                  display: "flex",
                  gap: "12px",
                  alignItems: "flex-start"
                }}
              >
              <div style={{ color: "var(--danger)", marginTop: "2px" }}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
              </div>
              <div>
                <p style={{ fontFamily: "var(--font-dm-sans)", fontSize: "0.9375rem", color: "var(--danger)", fontWeight: 700, marginBottom: "4px" }}>
                  {t("Save error", "Error al guardar")}
                </p>
                <p className="text-caption" style={{ fontFamily: "var(--font-dm-sans)", color: "var(--danger)", opacity: 0.9, lineHeight: 1.4 }}>
                  {confirmError}
                </p>
              </div>
            </div>

            <div className="flex flex-col gap-3">
              <Button
                type="button"
                variant="destructive"
                onClick={() => { setClickedAction("plain"); handleConfirm(); }}
                disabled={confirmingAction !== "none"}
                className="w-full rounded-full"
                style={{ fontFamily: "var(--font-dm-sans)", minHeight: "44px" }}
              >
                {confirmingAction === "plain"
                  ? <><CircleNotch className="icon-sm animate-spin" aria-hidden />{" "}{t("Retrying...", "Reintentando...")}</>
                  : t("Retry saving now", "Reintentar guardado ahora")}
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={handleEditParsedSale}
                disabled={confirmingAction !== "none"}
                className="w-full rounded-full"
                style={{ fontFamily: "var(--font-dm-sans)", minHeight: "44px" }}
              >
                {t("Back to edit", "Volver a editar")}
              </Button>
            </div>
          </div>
        ) : (
          <div className="mt-3 flex flex-col gap-2">
            <Button
              type="button"
              onClick={() => { setClickedAction("plain"); handleConfirm(); }}
              disabled={confirmingAction !== "none"}
              className="w-full rounded-full"
              style={{ fontFamily: "var(--font-dm-sans)", minHeight: "44px", backgroundColor: "var(--action-primary-bg)", color: "var(--action-primary-fg)" }}
            >
              {confirmingAction === "plain"
                ? <><CircleNotch className="icon-sm animate-spin" aria-hidden />{" "}{t("Saving...", "Guardando...")}</>
                : t("Confirm sale", "Confirmar venta")}
            </Button>
            {handleConfirmAndSendWhatsapp && (
              <Button
                type="button"
                variant="outline"
                onClick={() => { setClickedAction("whatsapp"); handleConfirmAndSendWhatsapp(); }}
                disabled={confirmingAction !== "none"}
                className="w-full rounded-full"
                style={{ fontFamily: "var(--font-dm-sans)", minHeight: "44px", color: "var(--brand)", borderColor: "var(--brand)" }}
              >
                {confirmingAction === "whatsapp"
                  ? <><CircleNotch className="icon-sm animate-spin" aria-hidden />{" "}{t("Sending...", "Enviando...")}</>
                  : t("Confirm and send via WhatsApp", "Confirmar y enviar por WhatsApp")}
              </Button>
            )}
            <div className="flex items-center justify-center">
              <Button
                type="button"
                variant="outline"
                onClick={handleCancelParsedSale}
                disabled={confirmingAction !== "none"}
                className="rounded-full"
                style={{ fontFamily: "var(--font-dm-sans)", minHeight: "44px", color: "var(--danger)", borderColor: "var(--danger-border)", opacity: confirmingAction !== "none" ? 0.4 : 0.75 }}
              >
                {t("Cancel sale", "Cancelar venta")}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
