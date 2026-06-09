"use client";

import { createContext, useContext } from "react";
import type { DashboardState } from "./types";

export interface BusinessDataContextValue {
  locale: DashboardState["locale"];
  business: DashboardState["business"];
  products: DashboardState["products"];
  clients: DashboardState["clients"];
  clientDrafts: DashboardState["clientDrafts"];
  manufacturers: DashboardState["manufacturers"];
  supplierDrafts: DashboardState["supplierDrafts"];
  sales: DashboardState["sales"];
  cashMovements: DashboardState["cashMovements"];
  invoices: DashboardState["invoices"];
  lastUpdated: DashboardState["lastUpdated"];
  notifications: DashboardState["notifications"];
  settingsForm: DashboardState["settingsForm"];
  settingsSaving: DashboardState["settingsSaving"];
  settingsError: DashboardState["settingsError"];
  settingsNotice: DashboardState["settingsNotice"];
  loadingPage: DashboardState["loadingPage"];
  pageError: DashboardState["pageError"];

  // Non-analytics derived values
  currentCash: DashboardState["currentCash"];
  totalIncome: DashboardState["totalIncome"];
  totalExpense: DashboardState["totalExpense"];
  inventoryChanges: DashboardState["inventoryChanges"];
  selectedInvoice: DashboardState["selectedInvoice"];
  selectedInvoiceBusiness: DashboardState["selectedInvoiceBusiness"];
  selectedInvoiceCustomer: DashboardState["selectedInvoiceCustomer"];
  selectedInvoiceSale: DashboardState["selectedInvoiceSale"];
  latestPurchaseRequestPayload: DashboardState["latestPurchaseRequestPayload"];

  // Contacts UI state
  newClient: DashboardState["newClient"];
  newClientSheetRequestId: DashboardState["newClientSheetRequestId"];
  clientSaving: DashboardState["clientSaving"];
  clientError: DashboardState["clientError"];
  clientNotice: DashboardState["clientNotice"];
  newSupplier: DashboardState["newSupplier"];
  supplierSaving: DashboardState["supplierSaving"];
  supplierError: DashboardState["supplierError"];
  supplierNotice: DashboardState["supplierNotice"];

  // Invoice-related state
  activeInvoiceId: DashboardState["activeInvoiceId"];
  invoiceStatusNotice: DashboardState["invoiceStatusNotice"];
  downloadingInvoiceId: DashboardState["downloadingInvoiceId"];
  downloadingPurchaseRequestId: DashboardState["downloadingPurchaseRequestId"];

  // Flash-saved UI state
  savedProductId: DashboardState["savedProductId"];
  savedClientId: DashboardState["savedClientId"];
  savedSupplierId: DashboardState["savedSupplierId"];
}

export const BusinessDataContext = createContext<BusinessDataContextValue | null>(null);

export function useBusinessDataContext(): BusinessDataContextValue {
  const ctx = useContext(BusinessDataContext);
  if (!ctx) throw new Error("useBusinessDataContext must be used within DashboardProviders");
  return ctx;
}
