// Assistant action types — extracted from types.ts to keep that file under
// the 400-LOC ceiling once edit_product was added to AssistantDestructiveAction.
// Re-exported from types.ts for backward compat, so existing imports
// from "../types" / "../../types" keep working unchanged.

import type { AssistantStockDraft, InvoiceStatus, PurchaseRequestRecord } from "./types";
import type { BulkPriceMode, BulkPriceDirection, MovementType } from "./command-parsers/shared";

export type AssistantDestructiveAction =
  | {
      type: "register_sale";
      matchedProductId: string;
      matchedCustomerId: string | null;
      autoSend: boolean;
    }
  | {
      // Inline new-customer sale: the server will upsert-by-phone before
      // creating the sale. Idempotent: same phone + same clientMessageId →
      // same customer record, no duplicate created.
      type: "register_sale_with_new_customer";
      matchedProductId: string;
      autoSend: boolean;
      newCustomer: {
        name: string;
        phone: string; // E.164 +549XXXXXXXXXX
      };
      // Sale line items embedded at confirmation-card build time so the
      // confirm handler can call sale.create directly without a second
      // /api/parse-sale round-trip.
      saleItems: Array<{ productId: string; quantity: number; unitPrice: number }>;
      saleTotal: number;
    }
  | {
      type: "delete_product";
      product: {
        id: string;
        name: string;
      };
    }
  | {
      type: "delete_supplier";
      supplier: {
        id: string;
        name: string;
      };
    }
  | {
      type: "delete_customer";
      customer: {
        id: string;
        name: string;
      };
    }
  | {
      type: "multi_delete_product";
      products: Array<{ id: string; name: string }>;
    }
  | {
      type: "undo";
      undoTarget: "sale" | "customer" | "stock";
      undoCount: number;
    }
  | {
      type: "adjust_stock";
      product: { id: string; name: string };
      mode: "set" | "increase" | "decrease";
      quantity: number;
    }
  | {
      type: "edit_product";
      product: { id: string; name: string };
      field: "price";
      value: string;
    }
  | {
      type: "bulk_price_update";
      amount: number;
      mode: BulkPriceMode;
      direction: BulkPriceDirection;
      productIds: string[];
      targetLabel: string;
    }
  | {
      type: "register_movement";
      movement: {
        movementType: MovementType;
        amount: number;
        description: string;
      };
    }
  | {
      type: "create_product_and_retry_sale";
      product: { name: string; price: number };
      retrySaleText: string;
    }
  | {
      type: "update_invoice_status";
      invoice: { id: string; invoiceNumber: string };
      status: InvoiceStatus;
    }
  | {
      type: "create_product";
      product: { name: string; price: number; stock: number; weightGrams?: number | null };
    }
  | {
      type: "update_business_profile";
      field: "name" | "phone" | "address" | "email" | "taxId" | "openingTime" | "closingTime";
      value: string;
    }
  | {
      type: "create_budget";
      customerName: string;
      items: Array<{ productId: string | null; name: string; quantity: number; unitPrice: number }>;
      autoSendWhatsapp: boolean;
    }
  | {
      type: "fuzzy_product_query";
      originalIntent: "check_stock" | "product_price_query";
      productId: string;
      productName: string;
    }
  | {
      type: "add_contact";
      kind: "customer" | "supplier";
      name: string;
      phone: string | null;
      email: string | null;
      taxId: string | null;
      contactName: string | null;
    }
  | {
      type: "create_purchase_request";
      supplierName: string | null;
      itemName: string;
      quantity: number | null;
      unitPrice: number | null;
    };

export interface AssistantConfirmationRequest {
  id: string;
  severity: "warning" | "critical";
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  action: AssistantDestructiveAction;
}

export type AssistantAction =
  | { type: "register_sale"; matchedProductId?: string | null; matchedCustomerId?: string | null; autoSend?: boolean }
  | {
      type: "register_movement";
      movement: {
        movementType: string;
        amount: number;
        description: string;
      } | null;
    }
  | {
      type: "select_invoice";
      invoice: {
        id: string;
        invoiceNumber: string;
      };
    }
  | {
      type: "update_invoice_status";
      invoice: {
        id: string;
        invoiceNumber: string;
      };
      status: InvoiceStatus;
    }
  | {
      type: "send_invoice_whatsapp";
      invoice: {
        id: string;
        invoiceNumber: string;
        customerPhone?: string | null;
      };
    }
  | {
      type: "download_invoice";
      invoice: {
        id: string;
        invoiceNumber: string;
      };
    }
  | {
      type: "select_purchase_request";
      request: PurchaseRequestRecord;
    }
  | {
      type: "download_purchase_request";
      request: PurchaseRequestRecord;
    }
  | {
      type: "send_purchase_request_whatsapp";
      request: PurchaseRequestRecord;
    }
  | {
      type: "adjust_stock";
      product: {
        id: string;
        name: string;
      };
      mode: "set" | "increase" | "decrease";
      quantity: number;
    }
  | {
      type: "edit_product";
      product: {
        id: string;
        name: string;
      };
      field: "name" | "price" | "costPrice" | "sku";
      value: string;
    }
  | {
      type: "multi_edit_product";
      edits: Array<{ productName: string; field: string; value: number }>;
    }
  | {
      type: "edit_customer";
      customer: {
        id: string;
        name: string;
      };
      field: "name" | "phone" | "email" | "taxId";
      value: string;
    }
  | {
      type: "edit_supplier";
      supplier: {
        id: string;
        name: string;
      };
      field: "name" | "phone" | "email" | "contactName";
      value: string;
    }
  | {
      type: "create_supplier";
      supplier: {
        name: string;
        phone: string;
        email: string;
        contactName: string;
      };
    }
  | {
      type: "create_customer";
      customer: {
        name?: string;
        phone?: string;
        email?: string;
        taxId?: string;
      };
    }
  | {
      type: "stock_load";
      draft: AssistantStockDraft;
    }
  | {
      type: "select_customer";
      saleText: string;
      clients: { id: string; name: string }[];
    }
  | {
      type: "confirm_cobro";
      // Slice 2: discriminador entre el flujo QR y el flujo alias personal
      // (modo informal, sin API MP). Default "qr" para preservar payloads
      // viejos que viajaran sin el campo.
      metodo?: "qr" | "alias";
      paymentIntentId: string;
      monto: number;
      qrPlaceholderUrl: string;
      // Camino corto MP: true cuando qrPlaceholderUrl es un data URL del QR real
      // generado por MP, false/undefined cuando es el SVG placeholder estático.
      qrIsReal?: boolean;
      // Sandbox flag: present (true) when MP credentials are absent and the
      // QR shown is a placeholder that does NOT process a real payment.
      // Undefined on real QRs. UI renders a visible "Sandbox" badge when true.
      sandbox?: true;
      // Slice 2: alias del dueño para mostrar al cliente cuando metodo === "alias".
      alias?: string | null;
      // Slice 3: timeout 2 min anti-comprobante-falso. ISO string.
      // Null en payloads viejos (rows pre-migration) — el cliente lo trata
      // como "no expira" y omite el countdown.
      expiresAt?: string | null;
      // Forwarded from NLU CobroQrIntent — presente cuando el empleado
      // nombró al cliente ("cobro 5000 a Carlos") y NLU lo resolvió.
      matchedCustomerId?: string | null;
      customerName?: string | null;
    };
