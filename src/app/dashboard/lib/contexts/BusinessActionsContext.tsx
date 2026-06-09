"use client";

import { createContext, useContext } from "react";
import type { DashboardState } from "./types";

export interface BusinessActionsContextValue {
  // Handlers
  reloadData: DashboardState["reloadData"];
  updateProduct: DashboardState["updateProduct"];
  deleteProduct: DashboardState["deleteProduct"];
  deleteClient: DashboardState["deleteClient"];
  deleteSupplier: DashboardState["deleteSupplier"];
  updateClientField: DashboardState["updateClientField"];
  updateClientAll: DashboardState["updateClientAll"];
  updateSupplierField: DashboardState["updateSupplierField"];
  updateSupplierAll: DashboardState["updateSupplierAll"];
  performImport: DashboardState["performImport"];
  handleCuitSaved: DashboardState["handleCuitSaved"];
  updateSettingsField: DashboardState["updateSettingsField"];
  handleSaveSettings: DashboardState["handleSaveSettings"];
  handleCreateClient: DashboardState["handleCreateClient"];
  openNewClientHelper: DashboardState["openNewClientHelper"];
  handleCreateSupplier: DashboardState["handleCreateSupplier"];
  downloadInvoicePdf: DashboardState["downloadInvoicePdf"];
  updateInvoiceStatus: DashboardState["updateInvoiceStatus"];
  sendInvoiceByWhatsapp: DashboardState["sendInvoiceByWhatsapp"];
  downloadPurchaseRequestPdf: DashboardState["downloadPurchaseRequestPdf"];
  onProductSaved: DashboardState["onProductSaved"];
  onClientSaved: DashboardState["onClientSaved"];
  onSupplierSaved: DashboardState["onSupplierSaved"];

  // Formatters
  moneyFmt: DashboardState["moneyFmt"];
  formatNumber: DashboardState["formatNumber"];
  formatDate: DashboardState["formatDate"];
  formatTime: DashboardState["formatTime"];
  movementDescriptionLabel: DashboardState["movementDescriptionLabel"];
  t: DashboardState["t"];

  // Stable useState setters
  setClientDrafts: DashboardState["setClientDrafts"];
  setSupplierDrafts: DashboardState["setSupplierDrafts"];
  setSettingsForm: DashboardState["setSettingsForm"];
  setSettingsError: DashboardState["setSettingsError"];
  setSettingsNotice: DashboardState["setSettingsNotice"];
  setNewClient: DashboardState["setNewClient"];
  setNewSupplier: DashboardState["setNewSupplier"];
  setActiveInvoiceId: DashboardState["setActiveInvoiceId"];
  setInvoiceStatusNotice: DashboardState["setInvoiceStatusNotice"];
}

export const BusinessActionsContext = createContext<BusinessActionsContextValue | null>(null);

export function useBusinessActionsContext(): BusinessActionsContextValue {
  const ctx = useContext(BusinessActionsContext);
  if (!ctx) throw new Error("useBusinessActionsContext must be used within DashboardProviders");
  return ctx;
}
