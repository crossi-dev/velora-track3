"use client";

import { createContext, useContext } from "react";
import type { DashboardState } from "./types";

export interface UIContextValue {
  activeTab: DashboardState["activeTab"];
  setActiveTab: DashboardState["setActiveTab"];
  quickAction: DashboardState["quickAction"];
  setQuickAction: DashboardState["setQuickAction"];
  sidebarOpen: DashboardState["sidebarOpen"];
  setSidebarOpen: DashboardState["setSidebarOpen"];
  successNotice: DashboardState["successNotice"];
  errorNotice: DashboardState["errorNotice"];
  setErrorNotice: DashboardState["setErrorNotice"];
  undoAction: DashboardState["undoAction"];
  setUndoAction: DashboardState["setUndoAction"];
  freshInvoiceId: DashboardState["freshInvoiceId"];
  setFreshInvoiceId: DashboardState["setFreshInvoiceId"];
  quickActionSaving: DashboardState["quickActionSaving"];
  quickActionError: DashboardState["quickActionError"];
  setQuickActionError: DashboardState["setQuickActionError"];
  tabLabel: DashboardState["tabLabel"];
  activeSectionMeta: DashboardState["activeSectionMeta"];
  dashboardQuickActions: DashboardState["dashboardQuickActions"];
  // Bible §4: facturas no es sección dedicada. Cualquier action handler que
  // antes hacía setActiveTab("invoices") debe usar setInvoiceSheetOpen(true)
  // para abrir InvoiceDetailSheet inline en cualquier tab activa.
  invoiceSheetOpen: DashboardState["invoiceSheetOpen"];
  setInvoiceSheetOpen: DashboardState["setInvoiceSheetOpen"];
}

export const UIContext = createContext<UIContextValue | null>(null);

export function useUIContextDashboard(): UIContextValue {
  const ctx = useContext(UIContext);
  if (!ctx) throw new Error("useUIContextDashboard must be used within DashboardProviders");
  return ctx;
}
