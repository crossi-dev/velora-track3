"use client";

export const OFFLINE_QUEUE_KEY = "velora.offline-queue.v1";

export interface ChatPayload {
  text: string;
  continueAssistantQuestion?: boolean;
  businessId?: string | null;
}

export interface OfflineSalePayload {
  customerId: string | null;
  customerName?: string;
  businessId?: string;
  total?: number;
  paymentMethod?: string | null;
  items: Array<{
    productId: string;
    productName?: string;
    quantity: number;
    unitPrice: number;
  }>;
}

export interface OfflineStockLoadPayload {
  items: Array<{
    productId: string | null;
    itemName: string;
    quantity: number;
    unitPrice: number;
  }>;
  supplierId?: string | null;
  supplierName?: string | null;
  note?: string | null;
  createPurchaseRequest?: boolean;
  autoCreateProduct?: boolean;
}

export interface OfflineCashMovementPayload {
  // "withdrawal" = sangría / retiro de efectivo de caja. Added 2026-06-03.
  type: "purchase" | "tax" | "salary" | "adjustment" | "income" | "withdrawal";
  description: string;
  amount: number;
  date?: string | null;
}

export interface OfflinePurchaseRequestPayload {
  supplierName: string | null;
  itemName: string;
  quantity: number;
  unitPrice: number | null;
}

export interface OfflinePaymentIntentPayload {
  saleId: string | null;
  monto: number;
  metodo: "qr_dynamic_fake" | "qr_dynamic_real" | "alias_personal";
}

export type QueuedAction =
  | {
      type: "assistant.chat";
      id: string;
      payload: ChatPayload;
      idempotencyKey: string;
      queuedAt: number;
      attempts: number;
      lastError?: string;
    }
  | {
      type: "sale.create";
      id: string;
      payload: OfflineSalePayload;
      idempotencyKey: string;
      queuedAt: number;
      attempts: number;
      lastError?: string;
    }
  | {
      type: "stock.load";
      id: string;
      payload: OfflineStockLoadPayload;
      idempotencyKey: string;
      queuedAt: number;
      attempts: number;
      lastError?: string;
    }
  | {
      type: "cash.movement";
      id: string;
      payload: OfflineCashMovementPayload;
      idempotencyKey: string;
      queuedAt: number;
      attempts: number;
      lastError?: string;
    }
  | {
      type: "purchase-request.create";
      id: string;
      payload: OfflinePurchaseRequestPayload;
      idempotencyKey: string;
      queuedAt: number;
      attempts: number;
      lastError?: string;
    }
  | {
      type: "payment_intent.create";
      id: string;
      payload: OfflinePaymentIntentPayload;
      idempotencyKey: string;
      queuedAt: number;
      attempts: number;
      lastError?: string;
    };

// Deprecated alias retained for downstream imports.
export type QueuedActionPayload = ChatPayload;

export interface QueueEnvelope {
  version: number;
  items: QueuedAction[];
}
