// src/lib/mcp/_lib/payments-backend-orders.port.ts — I/O types for listPendingOrders.
//
// Extracted from payments-backend.port.ts to stay under the 300-line file-size limit.
// Re-exported by payments-backend.port.ts so all callers continue to import from one place.
//
// These types are shared by listPendingOrders, getCobroDetail, and getDeliveryReceipt
// (all three reuse PendingOrderItem for their line-item shape).

export interface ListPendingOrdersInput {
  tenantId: string;
}

export interface PendingOrderItem {
  productId: string | null;
  name: string;
  quantity: number;
  unitPrice: number; // ARS pesos (not minor units)
}

/**
 * A pending PaymentIntent mapped to a display shape for the owner dashboard.
 * customerName and createdAt are Velora display extensions — not part of the
 * UCP Order spec (https://ucp.dev/latest/specification/order/), which has no
 * buyer or created_at fields.
 */
export interface PendingOrder {
  id: string;
  customerName: string;
  items: PendingOrderItem[];
  totalARS: number; // ARS pesos (not minor units)
  status: "pending";
  createdAt: Date;
  checkoutUrl: string | null;
}
