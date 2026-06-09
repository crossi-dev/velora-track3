"use client";

import React, { useRef } from "react";
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
import type { Product } from "@/domain";
import type { QuickActionMode } from "../lib/types";

interface QuickStockFormProps {
  setQuickAction: (action: QuickActionMode) => void;
  quickActionSaving: boolean;
  products: Product[];
  quickStock: { productId: string; quantity: string; unitCost: string; note: string };
  setQuickStock: (updater: (current: { productId: string; quantity: string; unitCost: string; note: string }) => { productId: string; quantity: string; unitCost: string; note: string }) => void;
  handleQuickStockSubmit: (event: React.SubmitEvent<HTMLFormElement>) => void;
  keyboardInset: number;
  t: (en: string, es: string) => string;
}

const affixStyle: React.CSSProperties = {
  position: "absolute", left: "0.6rem", top: "50%", transform: "translateY(-50%)",
  color: "var(--muted-foreground, #6b7280)", fontSize: "0.875rem",
  pointerEvents: "none", userSelect: "none",
};

export function QuickStockForm({
  setQuickAction,
  quickActionSaving,
  products,
  quickStock,
  setQuickStock,
  handleQuickStockSubmit,
  keyboardInset,
  t,
}: QuickStockFormProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, true);

  return (
    <>
      <div className="fixed inset-0 z-[80] bg-black/45 transition-opacity" aria-hidden="true" onClick={() => setQuickAction(null)} />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("Add stock", "Cargar stock")}
        className="fixed inset-x-0 bottom-0 z-[81] flex flex-col bg-background text-foreground"
        style={{ borderRadius: "var(--sheet-radius, 16px) var(--sheet-radius, 16px) 0 0", maxHeight: `calc(100dvh - ${keyboardInset}px)`, paddingBottom: "max(16px, env(safe-area-inset-bottom))", transform: `translateY(-${keyboardInset}px)`, transition: "transform 150ms ease, max-height 150ms ease" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center px-4 pt-3 pb-1">
          <h2 className="text-lg font-semibold">{t("Add stock", "Cargar stock")}</h2>
        </div>

        <div className="flex-1 overflow-y-auto px-4 pb-1 custom-scrollbar">
          {products.length === 0 ? (
            <div className="rounded-xl p-4 bg-muted">
              <p className="text-sm text-muted-foreground">
                {t("No products yet. Create one first.", "No hay productos. Creá uno primero.")}
              </p>
              <div className="mt-3">
                <Button type="button" onClick={() => setQuickAction("product")} className="w-full">
                  {t("Create product", "Crear producto")}
                </Button>
              </div>
            </div>
          ) : (
            <form id="quick-stock-form" onSubmit={(event) => void handleQuickStockSubmit(event)} className="flex flex-col gap-2">
              <Select
                value={quickStock.productId || undefined}
                onValueChange={(productId) => setQuickStock((current) => ({ ...current, productId }))}
                required
              >
                <SelectTrigger className="w-full" aria-label={t("Product", "Producto")}>
                  <SelectValue placeholder={t("Product...", "Producto...")} />
                </SelectTrigger>
                <SelectContent>
                  {products.map((product) => (
                    <SelectItem key={product.id} value={product.id}>{product.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <div className="flex gap-2">
                <Input type="number" inputMode="numeric" min="1" required value={quickStock.quantity} onChange={(e) => setQuickStock((current) => ({ ...current, quantity: e.target.value }))} placeholder={t("Qty.", "Cant.")} className="flex-1" />
                <div className="relative flex-1">
                  <span style={affixStyle}>$</span>
                  <Input type="number" inputMode="decimal" min="0" step="0.01" value={quickStock.unitCost} onChange={(e) => setQuickStock((current) => ({ ...current, unitCost: e.target.value }))} placeholder={t("Unit cost", "Costo u.")} className="pl-6" />
                </div>
              </div>

              <Input type="text" value={quickStock.note} onChange={(e) => setQuickStock((current) => ({ ...current, note: e.target.value }))} placeholder={t("Note (optional)", "Nota (opcional)")} />

              {(() => {
                const sel = products.find((p) => p.id === quickStock.productId);
                if (!sel) return null;
                const qty = Number(quickStock.quantity);
                const after = sel.stock + (qty > 0 ? qty : 0);
                return (
                  <div className="flex items-center justify-between rounded-xl px-3 py-2 bg-muted">
                    <span className="text-xs text-muted-foreground">{t("Stock", "Stock")}</span>
                    <span className="text-xs font-bold">{sel.stock} → {after}</span>
                  </div>
                );
              })()}
            </form>
          )}
        </div>

        <div className="px-4 pt-1 pb-0 flex flex-col gap-1.5">
          {products.length > 0 && (
            <Button type="submit" form="quick-stock-form" disabled={quickActionSaving} className="w-full">
              {quickActionSaving ? t("Saving...", "Guardando...") : t("Confirm", "Confirmar")}
            </Button>
          )}
          <Button type="button" variant="ghost" onClick={() => setQuickAction(null)} className="w-full">
            {t("Cancel", "Cancelar")}
          </Button>
        </div>
      </div>
    </>
  );
}
