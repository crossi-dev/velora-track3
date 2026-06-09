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
import type { QuickActionMode } from "../lib/types";
import type { MovementType } from "../lib/command-parsers/shared";

type QuickMovement = { type: MovementType; amount: string; description: string };

interface QuickMovementFormProps {
  setQuickAction: (action: QuickActionMode) => void;
  quickActionSaving: boolean;
  quickMovement: QuickMovement;
  setQuickMovement: (updater: (current: QuickMovement) => QuickMovement) => void;
  handleQuickMovementSubmit: (event: React.SubmitEvent<HTMLFormElement>) => void;
  keyboardInset: number;
  t: (en: string, es: string) => string;
}

export function QuickMovementForm({
  setQuickAction,
  quickActionSaving,
  quickMovement,
  setQuickMovement,
  handleQuickMovementSubmit,
  keyboardInset,
  t,
}: QuickMovementFormProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, true);

  return (
    <>
      <div className="fixed inset-0 z-[80] bg-black/45 transition-opacity" aria-hidden="true" onClick={() => setQuickAction(null)} />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("Cash movement", "Movimiento de caja")}
        className="fixed inset-x-0 bottom-0 z-[81] flex flex-col bg-background text-foreground"
        style={{ borderRadius: "var(--sheet-radius, 16px) var(--sheet-radius, 16px) 0 0", maxHeight: `calc(100dvh - ${keyboardInset}px)`, paddingBottom: "max(16px, env(safe-area-inset-bottom))", transform: `translateY(-${keyboardInset}px)`, transition: "transform 150ms ease, max-height 150ms ease" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center px-4 pt-3 pb-1">
          <h2 className="text-lg font-semibold">{t("Cash movement", "Movimiento de caja")}</h2>
        </div>

        <div className="flex-1 overflow-y-auto px-4 pb-1 custom-scrollbar">
          <form id="quick-movement-form" onSubmit={(event) => void handleQuickMovementSubmit(event)} className="flex flex-col gap-2">
            <Select
              value={quickMovement.type}
              onValueChange={(v) => setQuickMovement((current) => ({ ...current, type: v as MovementType }))}
              required
            >
              <SelectTrigger className="w-full" aria-label={t("Movement type", "Tipo de movimiento")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="purchase">{t("Purchase", "Compra")}</SelectItem>
                <SelectItem value="tax">{t("Tax", "Impuesto")}</SelectItem>
                <SelectItem value="salary">{t("Salary", "Salario")}</SelectItem>
                <SelectItem value="income">{t("Income", "Ingreso")}</SelectItem>
                <SelectItem value="adjustment">{t("Adjustment", "Ajuste")}</SelectItem>
                {/* "withdrawal" = sangría / retiro de efectivo de caja. Added 2026-06-03. */}
                <SelectItem value="withdrawal">{t("Cash withdrawal", "Retiro / Sangría")}</SelectItem>
              </SelectContent>
            </Select>

            <div className="flex gap-2">
              <div className="relative flex-1">
                <span style={{ position: "absolute", left: "0.6rem", top: "50%", transform: "translateY(-50%)", color: "var(--muted-foreground, #6b7280)", fontSize: "0.875rem", pointerEvents: "none", userSelect: "none" }}>$</span>
                <Input type="number" inputMode="decimal" step="0.01" min="0" required value={quickMovement.amount} onChange={(e) => setQuickMovement((current) => ({ ...current, amount: e.target.value }))} placeholder={t("Amount", "Monto")} className="pl-6" />
              </div>
              <Input type="text" required value={quickMovement.description} onChange={(e) => setQuickMovement((current) => ({ ...current, description: e.target.value }))} placeholder={t("Description", "Descripción")} className="flex-1" />
            </div>
          </form>
        </div>

        <div className="px-4 pt-1 pb-0 flex flex-col gap-1.5">
          <Button type="submit" form="quick-movement-form" disabled={quickActionSaving} className="w-full">
            {quickActionSaving ? t("Saving...", "Guardando...") : t("Confirm", "Confirmar")}
          </Button>
          <Button type="button" variant="ghost" onClick={() => setQuickAction(null)} className="w-full">
            {t("Cancel", "Cancelar")}
          </Button>
        </div>
      </div>
    </>
  );
}
