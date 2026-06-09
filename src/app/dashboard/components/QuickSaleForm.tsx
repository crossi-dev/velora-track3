"use client";

import React, { useRef } from "react";
import { WarningIcon } from "@phosphor-icons/react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useFocusTrap } from "../lib/hooks/useFocusTrap";
import type { Product, ContactRow } from "@/domain";
import type { QuickActionMode } from "../lib/types";

interface QuickSaleFormProps {
  setQuickAction: (action: QuickActionMode) => void;
  quickActionSaving: boolean;
  products: Product[];
  quickSale: { productId: string; quantity: string; customerId: string; unitPrice: string };
  setQuickSale: (updater: (current: { productId: string; quantity: string; customerId: string; unitPrice: string }) => { productId: string; quantity: string; customerId: string; unitPrice: string }) => void;
  clients: ContactRow[];
  handleQuickSaleSubmit: (event: React.SubmitEvent<HTMLFormElement>) => void;
  businessCurrency: string;
  keyboardInset: number;
  t: (en: string, es: string) => string;
}

// eslint-disable-next-line max-lines-per-function -- composition root, not a logic violation
export function QuickSaleForm({
  setQuickAction,
  quickActionSaving,
  products,
  quickSale,
  setQuickSale,
  clients,
  handleQuickSaleSubmit,
  businessCurrency,
  keyboardInset,
  t,
}: QuickSaleFormProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, true);

  return (
    <>
      <div className="fixed inset-0 z-[80] bg-black/45 transition-opacity" aria-hidden="true" onClick={() => setQuickAction(null)} />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("Quick sale", "Venta rápida")}
        className="fixed inset-x-0 bottom-0 z-[81] flex flex-col bg-background text-foreground"
        style={{
          borderRadius: "var(--sheet-radius, 16px) var(--sheet-radius, 16px) 0 0",
          maxHeight: `calc(100dvh - ${keyboardInset}px)`,
          paddingBottom: "max(16px, env(safe-area-inset-bottom))",
          transform: `translateY(-${keyboardInset}px)`,
          transition: "transform 150ms ease, max-height 150ms ease",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center px-4 pt-3 pb-1">
          <h2 className="text-lg font-semibold">{t("Quick sale", "Venta rápida")}</h2>
        </div>

        <div className="flex-1 overflow-y-auto px-4 pb-1 custom-scrollbar">
          <form id="manual-sale-form" onSubmit={(e) => void handleQuickSaleSubmit(e)} className="flex flex-col gap-2">

            <div className="flex gap-2">
              <Select
                value={quickSale.productId || undefined}
                onValueChange={(productId) => setQuickSale((c) => ({ ...c, productId }))}
                required
              >
                <SelectTrigger className="flex-1" aria-label={t("Product", "Producto")}>
                  <SelectValue placeholder={t("Product...", "Producto...")} />
                </SelectTrigger>
                <SelectContent>
                  {products.map((p) => (
                    <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Input
                required
                type="number"
                inputMode="numeric"
                step="1"
                min="1"
                className="w-20 text-center"
                placeholder={t("Qty.", "Cant.")}
                value={quickSale.quantity}
                onChange={(e) => setQuickSale((c) => ({ ...c, quantity: e.target.value }))}
              />
            </div>

            <Select
              value={quickSale.customerId || "__walk_in__"}
              onValueChange={(v) => setQuickSale((c) => ({ ...c, customerId: v === "__walk_in__" ? "" : v }))}
            >
              <SelectTrigger className="w-full" aria-label={t("Customer", "Cliente")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__walk_in__">{t("Walk-in customer", "Consumidor Final")}</SelectItem>
                {clients.map((c) => (
                  <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>

            {(() => {
              const isConsumidorFinal = !quickSale.customerId;
              const selectedCustomer = !isConsumidorFinal
                ? clients.find((c) => c.id === quickSale.customerId) ?? null
                : null;
              const hasPhone = Boolean(selectedCustomer?.phone?.trim());
              if (!isConsumidorFinal && hasPhone) return null;

              const message = isConsumidorFinal
                ? t(
                    "Walk-in customer won't receive a WhatsApp invoice. Pick a customer with a phone to send it.",
                    "Consumidor Final no recibirá comprobante por WhatsApp. Cargá un cliente con teléfono si querés mandárselo."
                  )
                : t(
                    "No phone on file — invoice won't be sent over WhatsApp.",
                    "Sin teléfono — el comprobante no llegará por WhatsApp."
                  );

              return (
                <div className="flex items-center gap-2 rounded-xl px-3 py-2" style={{ backgroundColor: "var(--warning-soft)" }}>
                  <WarningIcon size={14} weight="bold" style={{ color: "var(--warning)", flexShrink: 0 }} aria-hidden />
                  <span className="text-xs font-semibold" style={{ color: "var(--warning)" }}>
                    {message}
                  </span>
                </div>
              );
            })()}

            {(() => {
              const sel = products.find((p) => p.id === quickSale.productId);
              if (!sel) return null;
              const qty = Number(quickSale.quantity);
              const storedPrice = Number(sel.price);
              const hasStoredPrice = Number.isFinite(storedPrice) && storedPrice > 0;
              const enteredPrice = Number(quickSale.unitPrice);
              const effectivePrice = hasStoredPrice ? storedPrice : (Number.isFinite(enteredPrice) && enteredPrice > 0 ? enteredPrice : null);
              const total = effectivePrice !== null && qty > 0 ? effectivePrice * qty : null;

              const stockWarning = sel.stock === 0
                ? t("Out of stock", "Sin stock")
                : qty > sel.stock
                ? t(`Only ${sel.stock} left`, `Te quedan ${sel.stock}`)
                : null;

              return (
                <>
                  {!hasStoredPrice && (
                    <div className="relative">
                      <span style={{ position: "absolute", left: "0.6rem", top: "50%", transform: "translateY(-50%)", color: "var(--muted-foreground, #6b7280)", fontSize: "0.875rem", pointerEvents: "none", userSelect: "none" }}>$</span>
                      <Input
                        required
                        type="number"
                        inputMode="decimal"
                        step="0.01"
                        min="0.01"
                        className="pl-6"
                        placeholder={t("Unit price", "Precio/u.")}
                        value={quickSale.unitPrice}
                        onChange={(e) => setQuickSale((c) => ({ ...c, unitPrice: e.target.value }))}
                        autoFocus
                      />
                    </div>
                  )}

                  {total !== null && (
                    <div className="flex items-center justify-between rounded-xl px-3 py-2" style={{ backgroundColor: "var(--surface-subtle)" }}>
                      <span className="text-xs font-semibold">{t("Total", "Total")}</span>
                      <span className="text-base font-extrabold" style={{ color: "var(--brand)" }}>
                        {total.toLocaleString("es-AR", { style: "currency", currency: businessCurrency || "ARS", minimumFractionDigits: 0, maximumFractionDigits: 2 })}
                      </span>
                    </div>
                  )}

                  {stockWarning && (
                    <div className="flex items-center gap-2 rounded-xl px-3 py-2" style={{ backgroundColor: "var(--danger-soft)" }}>
                      <WarningIcon size={14} weight="bold" style={{ color: "var(--danger)", flexShrink: 0 }} aria-hidden />
                      <span className="text-xs font-semibold" style={{ color: "var(--danger, #DC2626)" }}>
                        {stockWarning}
                      </span>
                    </div>
                  )}
                </>
              );
            })()}
          </form>
        </div>

        <div className="px-4 pt-1 pb-0 flex flex-col gap-1.5">
          {(() => {
            const sel = products.find((p) => p.id === quickSale.productId);
            const storedPrice = sel ? Number(sel.price) : 0;
            const hasStoredPrice = Number.isFinite(storedPrice) && storedPrice > 0;
            const enteredPrice = Number(quickSale.unitPrice);
            const priceReady = hasStoredPrice || (Number.isFinite(enteredPrice) && enteredPrice > 0);
            const needsPriceHint = sel && !hasStoredPrice && !priceReady;
            return (
              <>
                {needsPriceHint && (
                  <p className="text-xs text-center text-muted-foreground m-0">
                    {t("Enter a price above to continue.", "Ingresá un precio para continuar.")}
                  </p>
                )}
                <Button
                  type="submit"
                  form="manual-sale-form"
                  disabled={quickActionSaving || !priceReady}
                  aria-busy={quickActionSaving}
                  className="w-full"
                >
                  {quickActionSaving && (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden={true} className="spinner" style={{ flexShrink: 0 }}>
                      <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
                    </svg>
                  )}
                  {quickActionSaving ? t("Processing...", "Preparando...") : t("Sell", "Vender")}
                </Button>
              </>
            );
          })()}
          <Button type="button" variant="ghost" onClick={() => setQuickAction(null)} className="w-full">
            {t("Cancel", "Cancelar")}
          </Button>
        </div>
      </div>
    </>
  );
}
