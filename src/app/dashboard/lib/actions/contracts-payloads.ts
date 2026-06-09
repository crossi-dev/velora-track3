"use client";

// Payload + result interfaces for dashboard actions and sale orchestrations.
// Extracted from contracts.ts to keep that file under the 400-LOC ceiling
// (CLAUDE.md "Code Size Contract"). The arrays of action keys, the type-level
// alignment proofs, and the ActionCatalog/SaleOrchestrationCatalog mapping
// stay in contracts.ts and import from here.

import type { ParsedSale, InvoicePayload } from "../types";
import type { PaymentMethodValue } from "@/domain/sale";

// ── Sale ──────────────────────────────────────────────────────────────

export interface SaleCreatePayload {
  businessId: string;
  customerId?: string | null;
  defaultCustomerName?: string;
  allowNegativeStock?: boolean;
  items: Array<{
    productId: string;
    quantity: number;
    unitPrice: number;
  }>;
  total: number;
  locale?: string | null;
  // Payment method for cash-register breakdown. Defaults to "efectivo" when absent.
  paymentMethod?: PaymentMethodValue;
  // When true, tells the server to skip its auto-whatsapp send (Path B) because
  // the client is sending via Path A (invoice send endpoint with real idempotency).
  skipAutoWhatsapp?: boolean;
}

export type SaleDraftSource = "assistant" | "manual_quick_action";

export interface SaleDraftOpenPayload {
  draft: ParsedSale;
  source?: SaleDraftSource;
}

export interface SaleDraftUpdatePayload {
  draft: ParsedSale;
  source?: SaleDraftSource;
}

export interface SaleDraftCancelPayload {
  emitChatMessage?: boolean;
}

export interface SaleConfirmPayload {
  preOpenedWindow?: Window | null;
}

export interface SaleConfirmAndSendWhatsappPayload {
  preOpenedWindow?: Window | null;
  draftOverride?: ParsedSale | null;
}

// ── Stock / cash ──────────────────────────────────────────────────────

export interface StockLoadCreatePayload {
  productId?: string | null;
  itemName?: string | null;
  quantity: number;
  unitPrice?: number | null;
  supplierId?: string | null;
  supplierName?: string | null;
  note?: string | null;
  createPurchaseRequest?: boolean;
  autoCreateProduct?: boolean;
}

export interface CashMovementCreatePayload {
  // "withdrawal" = sangría / retiro de efectivo de caja. Added 2026-06-03.
  type: "purchase" | "tax" | "salary" | "adjustment" | "income" | "withdrawal";
  amount: number;
  description: string;
  date?: string | null;
}

// ── Product ───────────────────────────────────────────────────────────

export interface ProductCreatePayload {
  businessId: string;
  name: string;
  price: number;
  stock: number;
  costPrice?: number | null;
  sku?: string | null;
  /** Weight in grams — optional; Logística falls back to 500 g/item when absent. */
  weightGrams?: number | null;
}

export interface ProductUpdatePayload {
  id: string;
  name?: string;
  price?: number;
  costPrice?: number | null;
  stock?: number;
  sku?: string | null;
  /** Weight in grams — nullable to clear an existing value. */
  weightGrams?: number | null;
  stockReason?: string | null;
  stockReferenceId?: string | null;
}

export interface ProductDeletePayload {
  id: string;
}

export interface ProductResolveOrCreatePayload {
  /** Product name as the user typed it. Lookup is case- and accent-insensitive. */
  name: string;
  /** Sale price used ONLY when the create branch fires; ignored on resolve. */
  price: number;
  /** Optional cost price; only applied on the create branch. */
  costPrice?: number | null;
}

export interface ProductResolveOrCreateResult {
  /** true if the product already existed in the catalog; false if it was created. */
  resolved: boolean;
  product: {
    id: string;
    name: string;
    price: number;
    costPrice: number | null;
    sku: string | null;
  };
}

export interface ProductBulkPriceUpdatePayload {
  amount: number;
  mode: "percentage" | "absolute";
  direction: "up" | "down" | "set";
  productIds?: string[];
}

// ── Customer / supplier ───────────────────────────────────────────────

export interface CustomerCreatePayload {
  /**
   * Derived server-side from auth context; stripped before the HTTP body is
   * sent (see executeDashboardAction "customer.create" case) so that the
   * createCustomerBodySchema .strict() call does not reject it.
   */
  businessId: string;
  name?: string | null;
  phone?: string | null;
  email?: string | null;
  taxId?: string | null;
  dni?: string | null;
  ivaCondition?: string | null;
  address?: string | null;
  postalCode?: string | null;
  city?: string | null;
}

export interface CustomerUpdatePayload {
  id: string;
  name?: string | null;
  phone?: string | null;
  email?: string | null;
  taxId?: string | null;
  ivaCondition?: string | null;
  address?: string | null;
  postalCode?: string | null;
  city?: string | null;
}

export interface CustomerDeletePayload {
  id: string;
}

export interface SupplierCreatePayload {
  /**
   * Derived server-side from auth context; stripped before the HTTP body is
   * sent (see executeDashboardAction "supplier.create" case) so that the
   * supplierCreateSchema .strict() call does not reject it.
   */
  businessId: string;
  name: string;
  phone?: string | null;
  email?: string | null;
  contactName?: string | null;
  /** Maps to supplierCreateSchema.leadTimeDays — optional delivery lead time in days. */
  leadTimeDays?: number | null;
}

export interface SupplierUpdatePayload {
  id: string;
  name?: string | null;
  phone?: string | null;
  email?: string | null;
  contactName?: string | null;
  /** Delivery lead time in days. Maps to supplierUpdateSchema.leadTimeDays. */
  leadTimeDays?: number | null;
}

export interface SupplierDeletePayload {
  id: string;
}

// ── Invoice ───────────────────────────────────────────────────────────

export interface InvoiceUpdateStatusPayload {
  invoiceId: string;
  status: "issued" | "sent" | "paid";
}

export interface InvoiceSendWhatsappPayload {
  invoiceId: string;
  phone?: string | null;
  /**
   * Optional pre-fetched invoice payload from the sale.create response.
   * When provided, the server skips its DB lookup entirely — eliminating
   * the read-after-write race against Neon's connection pooler.
   */
  payload?: InvoicePayload | null;
  /** Optional pre-fetched invoice number, paired with `payload`. */
  invoiceNumber?: string | null;
}

// ── Business ──────────────────────────────────────────────────────────

export interface BusinessUpdatePayload {
  name?: string;
  type?: string;
  email?: string | null;
  cuit?: string | null;
  address?: string | null;
  phone?: string | null;
  whatsappPhone?: string | null;
  // Cobro QR slice 2 — alias personal MP/CVU del dueño (modo informal).
  alias?: string | null;
  openingTime?: string | null;
  closingTime?: string | null;
  currency?: string;
  taxRate?: number | string;
  ivaCondition?: string | null;
  puntoVenta?: string | null;
  iibb?: string | null;
  activityStart?: string | null;
  allowNegativeStock?: boolean;
  defaultCustomer?: string;
  allowSaleWithoutCustomer?: boolean;
  openReceiptAfterSale?: boolean;
  autoCreateProductOnStockLoad?: boolean;
  suggestWhatsappAfterSale?: boolean;
  lowStockThreshold?: number;
  postalCode?: string | null;
  courierPreference?: string | null;
  notifyLowStockWa?: boolean;
  // E.164 WhatsApp Business phone number — lightweight pre-Embedded-Signup capture.
  whatsappBusinessPhoneE164?: string | null;
}

// ── Undo / purchase-request / budget ──────────────────────────────────

export interface UndoExecutePayload {
  target:
    | "sale"
    | "customer"
    | "stock"
    | "product"
    | "supplier"
    | "cash-movement"
    | "product-create";
  count?: number;
  stockMovementIds?: string[];
  productId?: string;
}

export interface PurchaseRequestCreatePayload {
  supplierName?: string | null;
  itemName: string;
  quantity: number;
  unitPrice?: number | null;
}

export interface PurchaseRequestSendWhatsappPayload {
  requestId: string;
}

export interface BudgetCreatePayload {
  customerName?: string | null;
  note?: string | null;
  items: Array<{
    productId?: string | null;
    name: string;
    quantity: number;
    unitPrice: number;
  }>;
}

export interface BudgetDeletePayload {
  budgetId: string;
}

export interface BudgetSendWhatsappPayload {
  budgetId: string;
  phone: string;
}

// ── Push notifications ────────────────────────────────────────────────

export interface PushSubscribePayload {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
  deviceLabel?: string | null;
}

export interface PushSubscribeResult {
  ok: true;
}
