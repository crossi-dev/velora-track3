"use client";

import type {
  CanonicalActionKey,
  CanonicalRuntimeActionKey,
} from "./architectureContract";
import type { InvoicePayload } from "../types";
import type {
  SaleCreatePayload,
  SaleDraftOpenPayload,
  SaleDraftUpdatePayload,
  SaleDraftCancelPayload,
  SaleConfirmPayload,
  SaleConfirmAndSendWhatsappPayload,
  StockLoadCreatePayload,
  CashMovementCreatePayload,
  ProductCreatePayload,
  ProductUpdatePayload,
  ProductDeletePayload,
  ProductResolveOrCreatePayload,
  ProductResolveOrCreateResult,
  ProductBulkPriceUpdatePayload,
  CustomerCreatePayload,
  CustomerUpdatePayload,
  CustomerDeletePayload,
  SupplierCreatePayload,
  SupplierUpdatePayload,
  SupplierDeletePayload,
  InvoiceUpdateStatusPayload,
  InvoiceSendWhatsappPayload,
  BusinessUpdatePayload,
  UndoExecutePayload,
  PurchaseRequestCreatePayload,
  PurchaseRequestSendWhatsappPayload,
  BudgetCreatePayload,
  BudgetDeletePayload,
  BudgetSendWhatsappPayload,
  PushSubscribePayload,
  PushSubscribeResult,
} from "./contracts-payloads";

export type {
  SaleCreatePayload,
  SaleDraftSource,
  SaleDraftOpenPayload,
  SaleDraftUpdatePayload,
  SaleDraftCancelPayload,
  SaleConfirmPayload,
  SaleConfirmAndSendWhatsappPayload,
  StockLoadCreatePayload,
  CashMovementCreatePayload,
  ProductCreatePayload,
  ProductUpdatePayload,
  ProductDeletePayload,
  ProductResolveOrCreatePayload,
  ProductResolveOrCreateResult,
  ProductBulkPriceUpdatePayload,
  CustomerCreatePayload,
  CustomerUpdatePayload,
  CustomerDeletePayload,
  SupplierCreatePayload,
  SupplierUpdatePayload,
  SupplierDeletePayload,
  InvoiceUpdateStatusPayload,
  InvoiceSendWhatsappPayload,
  BusinessUpdatePayload,
  UndoExecutePayload,
  PurchaseRequestCreatePayload,
  PurchaseRequestSendWhatsappPayload,
  BudgetCreatePayload,
  BudgetDeletePayload,
  BudgetSendWhatsappPayload,
  PushSubscribePayload,
  PushSubscribeResult,
} from "./contracts-payloads";

export const DASHBOARD_ACTION_KEYS = [
  "sale.create",
  "stock.adjust",
  "stock-load.create",
  "cash-movement.create",
  "product.create",
  "product.update",
  "product.delete",
  "product.resolve-or-create",
  "customer.create",
  "customer.update",
  "customer.delete",
  "supplier.create",
  "supplier.update",
  "supplier.delete",
  "invoice.update-status",
  "invoice.send-whatsapp",
  "business.update",
  "undo.execute",
  "purchase-request.create",
  "purchase-request.send-whatsapp",
  "product.bulk-price-update",
  "product.multi-price-update",
  "budget.create",
  "budget.delete",
  "budget.send-whatsapp",
  "push-notifications.subscribe",
] as const;

export type ActionKey = (typeof DASHBOARD_ACTION_KEYS)[number];

export const SALE_ORCHESTRATION_ACTION_KEYS = [
  "sale.draft.open",
  "sale.draft.update",
  "sale.draft.cancel",
  "sale.confirm",
  "sale.confirm-and-send-whatsapp",
] as const;

export type SaleOrchestrationActionKey = (typeof SALE_ORCHESTRATION_ACTION_KEYS)[number];

type RuntimeActionsAreCanonical = ActionKey extends CanonicalActionKey ? true : false;
const runtimeActionsAreCanonical: RuntimeActionsAreCanonical = true;
void runtimeActionsAreCanonical;

type RuntimeActionSetMatchesContract = [ActionKey] extends [CanonicalRuntimeActionKey]
  ? [CanonicalRuntimeActionKey] extends [ActionKey]
    ? true
    : false
  : false;
const runtimeActionSetMatchesContract: RuntimeActionSetMatchesContract = true;
void runtimeActionSetMatchesContract;

interface ActionCatalog {
  "sale.create": {
    payload: SaleCreatePayload;
    result: {
      sale?: { id: string; totalAmount: number; status: string };
      invoice?: { id: string; invoiceNumber: string; payload?: InvoicePayload };
    };
  };
  "stock.adjust": {
    payload: {
      id: string;
      stock: number;
      stockReason?: string | null;
      stockReferenceId?: string | null;
    };
    result: { ok: boolean };
  };
  "stock-load.create": {
    payload: StockLoadCreatePayload;
    result: {
      stockLoad?: { id?: string; stockMovementId?: string };
      request?: { id: string; requestNumber: string };
    };
  };
  "cash-movement.create": {
    payload: CashMovementCreatePayload;
    result: { movement?: { id: string } };
  };
  "product.create": {
    payload: ProductCreatePayload;
    result: { product?: { id: string; name: string } };
  };
  "product.update": {
    payload: ProductUpdatePayload;
    result: { ok: boolean };
  };
  "product.delete": {
    payload: ProductDeletePayload;
    result: { ok: boolean };
  };
  "product.resolve-or-create": {
    payload: ProductResolveOrCreatePayload;
    result: ProductResolveOrCreateResult;
  };
  "customer.create": {
    payload: CustomerCreatePayload;
    result: { customer?: { id: string; name: string } };
  };
  "customer.update": {
    payload: CustomerUpdatePayload;
    result: { ok: boolean };
  };
  "customer.delete": {
    payload: CustomerDeletePayload;
    result: { ok: boolean };
  };
  "supplier.create": {
    payload: SupplierCreatePayload;
    result: { supplier?: { id: string; name: string } };
  };
  "supplier.update": {
    payload: SupplierUpdatePayload;
    result: { ok: boolean };
  };
  "supplier.delete": {
    payload: SupplierDeletePayload;
    result: { ok: boolean };
  };
  "invoice.update-status": {
    payload: InvoiceUpdateStatusPayload;
    result: { invoice?: { id: string; status: "issued" | "sent" | "paid" } };
  };
  "invoice.send-whatsapp": {
    payload: InvoiceSendWhatsappPayload;
    result: { ok: boolean; sentTo?: string; invoiceNumber?: string; pdfAttached?: boolean };
  };
  "business.update": {
    payload: BusinessUpdatePayload;
    result: { ok: boolean; business?: { id: string; cuit?: string | null } };
  };
  "undo.execute": {
    payload: UndoExecutePayload;
    result: { deleted: number; summary: string[] };
  };
  "product.bulk-price-update": {
    payload: ProductBulkPriceUpdatePayload;
    result: { updated: number; summary: string };
  };
  "product.multi-price-update": {
    payload: { items: Array<{ productId: string; price?: number; costPrice?: number }> };
    result: { updated: number; summary: string };
  };
  "purchase-request.create": {
    payload: PurchaseRequestCreatePayload;
    result: { id: string; requestNumber: string };
  };
  "purchase-request.send-whatsapp": {
    payload: PurchaseRequestSendWhatsappPayload;
    result: { ok: boolean; sentTo?: string; requestNumber?: string };
  };
  "budget.create": {
    payload: BudgetCreatePayload;
    result: { budget?: { id: string; budgetNumber: string } };
  };
  "budget.delete": {
    payload: BudgetDeletePayload;
    result: { ok: boolean };
  };
  "budget.send-whatsapp": {
    payload: BudgetSendWhatsappPayload;
    result: { ok: boolean; sentTo?: string; budgetNumber?: string };
  };
  "push-notifications.subscribe": {
    payload: PushSubscribePayload;
    result: PushSubscribeResult;
  };
}

interface SaleOrchestrationCatalog {
  "sale.draft.open": {
    payload: SaleDraftOpenPayload;
    result: { ok: true };
  };
  "sale.draft.update": {
    payload: SaleDraftUpdatePayload;
    result: { ok: true };
  };
  "sale.draft.cancel": {
    payload: SaleDraftCancelPayload;
    result: { ok: true };
  };
  "sale.confirm": {
    payload: SaleConfirmPayload;
    result: { ok: boolean; invoiceId?: string | null };
  };
  "sale.confirm-and-send-whatsapp": {
    payload: SaleConfirmAndSendWhatsappPayload;
    result: { ok: boolean; invoiceId?: string | null };
  };
}

export type ActionPayload<K extends ActionKey> = ActionCatalog[K]["payload"];
export type ActionResult<K extends ActionKey> = ActionCatalog[K]["result"];
export type SaleOrchestrationPayload<K extends SaleOrchestrationActionKey> =
  SaleOrchestrationCatalog[K]["payload"];
export type SaleOrchestrationResult<K extends SaleOrchestrationActionKey> =
  SaleOrchestrationCatalog[K]["result"];
