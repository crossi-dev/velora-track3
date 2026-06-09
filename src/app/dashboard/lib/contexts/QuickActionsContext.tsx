"use client";

import { createContext, useContext } from "react";
import type { DashboardState } from "./types";

export interface QuickActionsContextValue {
  quickStock: DashboardState["quickStock"];
  setQuickStock: DashboardState["setQuickStock"];
  quickMovement: DashboardState["quickMovement"];
  setQuickMovement: DashboardState["setQuickMovement"];
  quickProduct: DashboardState["quickProduct"];
  setQuickProduct: DashboardState["setQuickProduct"];
  quickSale: DashboardState["quickSale"];
  setQuickSale: DashboardState["setQuickSale"];
  handleQuickStockSubmit: DashboardState["handleQuickStockSubmit"];
  handleQuickMovementSubmit: DashboardState["handleQuickMovementSubmit"];
  handleQuickProductSubmit: DashboardState["handleQuickProductSubmit"];
  handleQuickSaleSubmit: DashboardState["handleQuickSaleSubmit"];
  openQuickAction: DashboardState["openQuickAction"];
}

export const QuickActionsContext = createContext<QuickActionsContextValue | null>(null);

export function useQuickActionsContext(): QuickActionsContextValue {
  const ctx = useContext(QuickActionsContext);
  if (!ctx) throw new Error("useQuickActionsContext must be used within DashboardProviders");
  return ctx;
}
