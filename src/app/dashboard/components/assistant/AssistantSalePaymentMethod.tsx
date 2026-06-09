"use client";

import React from "react";
import type { PaymentMethodValue } from "@/domain/sale";

// PaymentMethod is an alias of the canonical domain type — kept for local readability.
export type PaymentMethod = PaymentMethodValue;

// UI labels paired with each canonical value.
export const PAYMENT_OPTIONS: ReadonlyArray<{ value: PaymentMethod; label: string }> = [
  { value: "efectivo",      label: "Efectivo" },
  { value: "qr",            label: "QR" },
  { value: "transferencia", label: "Transferencia" },
  { value: "tarjeta",       label: "Tarjeta" },
];

interface AssistantSalePaymentMethodProps {
  value: PaymentMethod;
  disabled: boolean;
  onChange: (method: PaymentMethod) => void;
  t: (en: string, es: string) => string;
}

export function AssistantSalePaymentMethod({
  value,
  disabled,
  onChange,
  t,
}: AssistantSalePaymentMethodProps) {
  return (
    <div className="mt-3" role="group" aria-label={t("Payment method", "Método de pago")}>
      <p
        style={{
          fontFamily: "var(--font-dm-sans)",
          fontWeight: 600,
          fontSize: "0.875rem",
          color: "var(--tone-muted)",
          marginBottom: "6px",
        }}
      >
        {t("Payment method", "Método de pago")}
      </p>
      <div className="flex flex-wrap gap-2">
        {PAYMENT_OPTIONS.map((opt) => {
          const isSelected = value === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => onChange(opt.value)}
              disabled={disabled}
              aria-pressed={isSelected}
              style={{
                fontFamily: "var(--font-dm-sans)",
                fontWeight: 600,
                fontSize: "0.875rem",
                padding: "6px 14px",
                borderRadius: "9999px",
                border: isSelected
                  ? "2px solid var(--action-primary-bg)"
                  : "1px solid var(--border)",
                backgroundColor: isSelected
                  ? "var(--action-primary-bg)"
                  : "var(--surface)",
                color: isSelected
                  ? "var(--action-primary-fg)"
                  : "var(--tone-body)",
                cursor: disabled ? "not-allowed" : "pointer",
                minHeight: "36px",
                transition:
                  "background-color 150ms ease, border-color 150ms ease, color 150ms ease",
              }}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
