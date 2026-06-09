"use client";

import { useMemo } from "react";
import { toFiniteNumber } from "./helpers";
import type {
  CashMovement,
  StockMovement,
  Business,
  InvoiceRecord,
  PurchaseRequestRecord,
} from "./types";

/**
 * currentCash = business.openingCash + cashTotal.
 * Safely coerces both operands to finite numbers.
 */
export function useCurrentCash(
  openingCash: Business["openingCash"] | undefined,
  cashTotal: number
) {
  return useMemo(
    () => toFiniteNumber(openingCash) + toFiniteNumber(cashTotal),
    [openingCash, cashTotal]
  );
}

/** Sum of all positive cash movement amounts. */
export function useTotalIncome(cashMovements: CashMovement[]) {
  return useMemo(
    () =>
      cashMovements
        .filter((m) => toFiniteNumber(m.amount) > 0)
        .reduce((sum, m) => sum + toFiniteNumber(m.amount), 0),
    [cashMovements]
  );
}

/** Absolute sum of all negative cash movement amounts. */
export function useTotalExpense(cashMovements: CashMovement[]) {
  return useMemo(
    () =>
      cashMovements
        .filter((m) => toFiniteNumber(m.amount) < 0)
        .reduce((sum, m) => sum + Math.abs(toFiniteNumber(m.amount)), 0),
    [cashMovements]
  );
}

/** Most-recent 20 stock movements; order preserved from the source list. */
export function useInventoryChanges(stockMovements: StockMovement[]) {
  return useMemo(() => stockMovements.slice(0, 20), [stockMovements]);
}

/**
 * Picks the invoice currently selected by the assistant (by id), falling back to
 * the first invoice in the list, or null if there are no invoices.
 */
export function resolveSelectedInvoice(
  invoices: InvoiceRecord[],
  activeInvoiceId: string | null
): InvoiceRecord | null {
  return (
    (activeInvoiceId ? invoices.find((inv) => inv.id === activeInvoiceId) : null) ??
    invoices[0] ??
    null
  );
}

/** Convenience tuple of denormalized fields used by the invoice panel. */
export function selectedInvoiceViewFields(selectedInvoice: InvoiceRecord | null) {
  const selectedInvoicePayload = selectedInvoice?.payload;
  return {
    selectedInvoicePayload,
    selectedInvoiceBusiness: selectedInvoicePayload?.business,
    selectedInvoiceCustomer: selectedInvoicePayload?.customer,
    selectedInvoiceSale: selectedInvoicePayload?.sale,
  };
}

/** Latest purchase request payload or undefined. */
export function selectLatestPurchaseRequestPayload(
  latestPurchaseRequest: PurchaseRequestRecord | null
) {
  return latestPurchaseRequest?.payload;
}
