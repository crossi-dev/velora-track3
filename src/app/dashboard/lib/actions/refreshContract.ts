"use client";

/**
 * Centralized post-mutation refresh contract.
 *
 * Instead of each action handler manually calling loadBusiness(), refreshChatHistory(),
 * etc., mutations declare which data slices changed via a RefreshPlan. The central
 * applyRefreshPlan function executes all necessary reloads in one place.
 *
 * This prevents the class of bugs where a handler forgets to reload a specific slice
 * (e.g., edit_product not calling loadBusiness — S5/S6/S7 bugs).
 */

export type RefreshSlice =
  | "products"
  | "customers"
  | "suppliers"
  | "sales"
  | "invoices"
  | "cash"
  | "chat"
  | "budgets";

export interface RefreshPlan {
  slices: RefreshSlice[];
}

export interface RefreshExecutors {
  loadBusiness: (opts?: { silent?: boolean; force?: boolean }) => Promise<void>;
  refreshChatHistory?: () => void;
}

// Pre-built refresh plans for common mutation types
export const REFRESH_PLANS: Record<string, RefreshPlan> = {
  "sale.create":              { slices: ["products", "sales", "invoices", "cash", "chat"] },
  "stock.adjust":             { slices: ["products"] },
  "stock-load.create":        { slices: ["products", "cash"] },
  "cash-movement.create":     { slices: ["cash"] },
  "product.create":           { slices: ["products"] },
  "product.update":           { slices: ["products"] },
  "product.delete":           { slices: ["products"] },
  "product.bulk-price-update": { slices: ["products"] },
  "customer.create":          { slices: ["customers"] },
  "customer.update":          { slices: ["customers"] },
  "customer.delete":          { slices: ["customers"] },
  "supplier.create":          { slices: ["suppliers"] },
  "supplier.update":          { slices: ["suppliers"] },
  "supplier.delete":          { slices: ["suppliers"] },
  "invoice.update-status":    { slices: ["invoices"] },
  "invoice.send-whatsapp":    { slices: ["invoices"] },
  "budget.create":            { slices: ["budgets"] },
  "budget.delete":            { slices: ["budgets"] },
  "budget.send-whatsapp":     { slices: ["budgets"] },
  "business.update":          { slices: ["products", "customers", "suppliers", "sales", "invoices", "cash"] },
  "undo.execute":             { slices: ["products", "sales", "invoices", "cash", "customers", "chat"] },
  "purchase-request.create":        { slices: [] },
  "purchase-request.send-whatsapp": { slices: [] },
  // Assistant-driven actions (not in executeDashboardAction but triggered by chat)
  "edit_product":             { slices: ["products"] },
  "edit_supplier":            { slices: ["suppliers"] },
  "delete_supplier":          { slices: ["suppliers"] },
  "edit_customer":            { slices: ["customers"] },
  "delete_customer":          { slices: ["customers"] },
  "create_supplier":          { slices: ["suppliers"] },
  "create_customer":          { slices: ["customers"] },
  "register_movement":        { slices: ["cash"] },
  "multi_edit_product":       { slices: ["products"] },
  "multi_delete_product":     { slices: ["products"] },
  "adjust_stock":             { slices: ["products"] },
};

/**
 * Apply a refresh plan after a successful mutation.
 * All data-slice refreshes go through loadBusiness (single reload).
 * Chat refresh goes through refreshChatHistory if the plan includes "chat".
 */
export function applyRefreshPlan(
  plan: RefreshPlan,
  executors: RefreshExecutors
): void {
  const needsBusinessReload = plan.slices.some((s) => s !== "chat");
  const needsChatRefresh = plan.slices.includes("chat");

  if (needsBusinessReload) {
    executors.loadBusiness({ silent: true, force: true }).catch(() => {});
  }

  if (needsChatRefresh) {
    executors.refreshChatHistory?.();
  }
}

/**
 * Get the refresh plan for a given action key.
 * Returns a minimal plan (empty slices) for unknown actions.
 */
export function getRefreshPlan(actionKey: string): RefreshPlan {
  return REFRESH_PLANS[actionKey] ?? { slices: [] };
}
