"use client";

import React, { useRef } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useFocusTrap } from "../lib/hooks/useFocusTrap";
import type { QuickActionMode } from "../lib/types";

type QuickProductState = { name: string; price: string; stock: string; sku: string; costPrice: string; weightGrams: string };

interface QuickProductFormProps {
  setQuickAction: (action: QuickActionMode) => void;
  quickActionSaving: boolean;
  quickProduct: QuickProductState;
  setQuickProduct: (updater: (current: QuickProductState) => QuickProductState) => void;
  handleQuickProductSubmit: (event: React.SubmitEvent<HTMLFormElement>) => void;
  keyboardInset: number;
  t: (en: string, es: string) => string;
}

// Currency/unit affix overlaid on a shadcn Input. The Input gets matching padding.
const affixStyle: React.CSSProperties = {
  position: "absolute", top: "50%", transform: "translateY(-50%)",
  color: "var(--muted-foreground, #6b7280)", fontSize: "0.875rem",
  pointerEvents: "none", userSelect: "none",
};

export function QuickProductForm({
  setQuickAction,
  quickActionSaving,
  quickProduct,
  setQuickProduct,
  handleQuickProductSubmit,
  keyboardInset,
  t,
}: QuickProductFormProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, true);

  return (
    <>
      <div className="fixed inset-0 z-[80] bg-black/45 transition-opacity" aria-hidden="true" onClick={() => setQuickAction(null)} />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("New product", "Nuevo producto")}
        className="fixed inset-x-0 bottom-0 z-[81] flex flex-col bg-background text-foreground"
        style={{ borderRadius: "var(--sheet-radius, 16px) var(--sheet-radius, 16px) 0 0", maxHeight: `calc(100dvh - ${keyboardInset}px)`, paddingBottom: "max(16px, env(safe-area-inset-bottom))", transform: `translateY(-${keyboardInset}px)`, transition: "transform 150ms ease, max-height 150ms ease" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center px-4 pt-3 pb-1">
          <h2 className="text-lg font-semibold">{t("New product", "Nuevo producto")}</h2>
        </div>

        <div className="px-4 pb-1">
          <form id="quick-product-form" onSubmit={(event) => void handleQuickProductSubmit(event)} className="flex flex-col gap-2">
            <Input
              type="text"
              required
              autoFocus
              value={quickProduct.name}
              onChange={(e) => setQuickProduct((c) => ({ ...c, name: e.target.value }))}
              placeholder={t("Name", "Nombre")}
            />
            <div className="flex gap-2">
              <div className="relative flex-1">
                <span style={{ ...affixStyle, left: "0.6rem" }}>$</span>
                <Input
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  min="0"
                  required
                  value={quickProduct.price}
                  onChange={(e) => setQuickProduct((c) => ({ ...c, price: e.target.value }))}
                  placeholder={t("Price", "Precio")}
                  className="pl-6"
                />
              </div>
              <Input
                type="number"
                inputMode="numeric"
                min="0"
                required
                value={quickProduct.stock}
                onChange={(e) => setQuickProduct((c) => ({ ...c, stock: e.target.value }))}
                placeholder={t("Stock", "Stock")}
                className="flex-1"
              />
            </div>
            <div className="flex gap-2">
              <Input
                type="text"
                value={quickProduct.sku}
                onChange={(e) => setQuickProduct((c) => ({ ...c, sku: e.target.value }))}
                placeholder={t("SKU (optional)", "SKU (opcional)")}
                className="flex-1"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
              />
              <div className="relative flex-1">
                <span style={{ ...affixStyle, left: "0.6rem" }}>$</span>
                <Input
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  min="0"
                  value={quickProduct.costPrice}
                  onChange={(e) => setQuickProduct((c) => ({ ...c, costPrice: e.target.value }))}
                  placeholder={t("Cost (optional)", "Costo (opcional)")}
                  className="pl-6"
                />
              </div>
            </div>
            <div className="relative">
              <label htmlFor="quick-product-weight" className="sr-only">
                {t("Weight in grams (optional)", "Peso en gramos (opcional)")}
              </label>
              <Input
                id="quick-product-weight"
                type="number"
                inputMode="numeric"
                min="1"
                step="1"
                value={quickProduct.weightGrams}
                onChange={(e) => setQuickProduct((c) => ({ ...c, weightGrams: e.target.value }))}
                placeholder={t("Weight in grams (optional)", "Peso en gramos (opcional)")}
                className="pr-8"
              />
              <span aria-hidden="true" style={{ ...affixStyle, right: "0.6rem" }}>g</span>
            </div>
          </form>
        </div>

        <div className="px-4 pt-1 pb-0 flex flex-col gap-1.5">
          <Button type="submit" form="quick-product-form" disabled={quickActionSaving} className="w-full">
            {quickActionSaving ? t("Saving...", "Guardando...") : t("Create", "Crear")}
          </Button>
          <Button type="button" variant="ghost" onClick={() => setQuickAction(null)} className="w-full">
            {t("Cancel", "Cancelar")}
          </Button>
        </div>
      </div>
    </>
  );
}
