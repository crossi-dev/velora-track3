// Distribuidora Mendoza — wholesale.order.create skill.
//
// Input:  { productName, qty, deliveryPostalCode?, buyerCuit?, buyerName? }
// Output: { orderId, estimatedDelivery, status: "pending_confirmation" }
//         OR { error: string } when product not found or qty invalid.

import { findCatalogItem } from "./catalog";
import { randomUUID } from "crypto";

interface OrderInput {
  productName?: string;
  qty?: number;
  deliveryPostalCode?: string;
  buyerCuit?: string;
  buyerName?: string;
}

interface OrderSuccess {
  orderId: string;
  productName: string;
  qty: number;
  unitPrice: number;
  totalPrice: number;
  currency: string;
  estimatedDelivery: string; // ISO 8601 date
  status: "pending_confirmation";
  buyerName?: string;
  trackingNote: string;
  /** Always true — no DB write occurs; this is a demo/simulation order. */
  mock: true;
  /** Always false — the order is NOT persisted in any database. */
  persisted: false;
}

interface OrderError {
  error: string;
}

export type OrderResult = OrderSuccess | OrderError;

export function handleOrder(params: OrderInput): OrderResult {
  const productName = params.productName ?? "";
  const qty = typeof params.qty === "number" && params.qty > 0 ? params.qty : 0;

  if (qty <= 0) {
    return { error: "La cantidad debe ser mayor a 0." };
  }

  const item = findCatalogItem(productName);
  if (!item) {
    return {
      error: `Producto "${productName}" no encontrado en el catálogo de Distribuidora Mendoza.`,
    };
  }

  const orderId = `DM-${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0, 6).toUpperCase()}`;

  const deliveryMs = item.deliveryDays * 24 * 60 * 60 * 1000;
  const estimatedDelivery = new Date(Date.now() + deliveryMs).toISOString().split("T")[0]!;

  return {
    orderId,
    productName: item.name,
    qty,
    unitPrice: item.unitPrice,
    totalPrice: item.unitPrice * qty,
    currency: "ARS",
    estimatedDelivery,
    status: "pending_confirmation",
    ...(params.buyerName ? { buyerName: params.buyerName } : {}),
    // Honest disclosure: this is a demo simulation — no DB write, not a real order.
    // Mirrors the *_MOCK_MODE convention used throughout Velora (ANDREANI_MOCK_MODE, etc.).
    trackingNote: "[DEMO] Pedido simulado — no persistido. En producción se coordinará entrega y pago.",
    mock: true as const,
    persisted: false as const,
  };
}
