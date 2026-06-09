import type { NextResponse } from "next/server";
import type { PostModelIntentParams } from "../router-params";
import type { PurchaseRequestDirectoryEntry } from "../types";

// ─── Handler contract ───────────────────────────────────────────────────────
//
// Each per-intent handler receives the same `PostModelIntentParams` and
// returns one of:
//   - NextResponse — a fully-formed response (clarification / confirmation)
//     that bypasses the dispatcher's `respond()` wrapper.
//   - HandlerBody — a payload the dispatcher wraps via `respond()` so compound
//     extras can be merged into the `actions` array.
//   - null — intent doesn't apply, fall through to the next handler.

export type CompoundAction =
  | { type: "register_sale"; matchedProductId: string | null; matchedCustomerId: string | null; autoSend?: boolean; qty?: number; unitPrice?: number }
  | { type: "edit_product"; product: { id: string; name: string }; field: string; value: string }
  | { type: "adjust_stock"; product: { id: string; name: string }; mode: string; quantity: number }
  | { type: "delete_product"; product: { id: string; name: string } }
  | { type: "bulk_price_update"; amount: number; mode: string; direction: string; productIds: string[]; targetLabel: string }
  | { type: "register_movement"; movement: { movementType: string; amount: number; description: string } }
  | { type: "create_product"; product: { name: string; price: number; stock: number } }
  | { type: "create_customer"; customer: { name: string; phone: string | null; email: string | null; taxId: string | null; dni?: string | null; address?: string | null; postalCode?: string | null; city?: string | null } }
  | { type: "create_supplier"; supplier: { name: string; phone: string; email: string; contactName: string } }
  | { type: "edit_customer"; customer: { id: string; name: string }; field: string; value: string }
  | { type: "edit_supplier"; supplier: { id: string; name: string }; field: string; value: string }
  | { type: "delete_customer"; customer: { id: string; name: string } }
  | { type: "delete_supplier"; supplier: { id: string; name: string } }
  | { type: "stock_load"; draft: { items: Array<{ itemName: string; quantity: string | number | null; unitPrice: string | number | null }>; supplierName: string } }
  | { type: "create_purchase_request"; supplierName: string | null; itemName: string; quantity: number | null; unitPrice: number | null }
  | { type: "create_budget"; customerName: string; items: Array<{ productId: string | null; name: string; quantity: number; unitPrice: number | null }>; autoSendWhatsapp: boolean }
  | { type: "undo"; undoTarget: "sale"; undoCount: number }
  | { type: "multi_delete_product"; products: Array<{ id: string; name: string }> }
  | { type: "multi_edit_product"; edits: Array<{ productName: string; field: string; value: number }> }
  | { type: "select_customer"; saleText: string; clients: Array<{ id: string; name: string }> }
  | { type: "select_invoice"; invoice: { id: string; invoiceNumber: string } }
  | { type: "select_purchase_request"; request: PurchaseRequestDirectoryEntry };

export interface HandlerBody {
  answer?: string;
  primaryAction?: CompoundAction | null;
  actions?: CompoundAction[];
  [k: string]: unknown;
}

export type HandlerResult = NextResponse | HandlerBody | null;

export type IntentHandler = (params: PostModelIntentParams) => HandlerResult | Promise<HandlerResult>;
