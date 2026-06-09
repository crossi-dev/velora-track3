"use client";

// Dispatch helper para Dead Man's Switch — toma un QueuedAction de tipo
// sale.create / stock.load / cash.movement y lo envía al endpoint
// correspondiente con el idempotencyKey embebido.
//
// Diseñado para ser llamado desde useOfflineQueueDrain. Retorna:
//   - { ok: true } si el server respondió 2xx → drain debería pop().
//   - { ok: false, retriable: true } si error de red o 5xx → mantener en
//     cola, bumpAttempts.
//   - { ok: false, retriable: false } si 4xx (excepto 408/429) →
//     markFailed (pop con error visible al user).
//
// El idempotency key viaja en header "X-Idempotency-Key" — el server-side
// `beginIdempotentMutation` deduplica replays.

import type { QueuedAction } from "../offline-queue";

export interface DispatchResult {
  ok: boolean;
  retriable: boolean;
  status?: number;
  errorMessage?: string;
}

const ENDPOINT_BY_TYPE: Record<string, string> = {
  "sale.create": "/api/sales/create",
  "stock.load": "/api/stock-loads",
  "cash.movement": "/api/cash-movements",
  "purchase-request.create": "/api/purchase-requests",
  "payment_intent.create": "/api/payment-intents/create",
};

const RETRIABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);

/**
 * POST el payload encolado al endpoint correspondiente. Devuelve
 * DispatchResult con clasificación de retry. Nunca tira — convierte
 * cualquier error en `{ ok: false }`.
 */
export async function dispatchQueuedMutation(
  item: QueuedAction,
): Promise<DispatchResult> {
  if (item.type === "assistant.chat") {
    // El chat tiene su propio drain via handleGo — no debería llegar acá.
    return { ok: false, retriable: false, errorMessage: "chat-not-supported-here" };
  }

  const endpoint = ENDPOINT_BY_TYPE[item.type];
  if (!endpoint) {
    return { ok: false, retriable: false, errorMessage: `unknown-type:${item.type}` };
  }

  // Build el body según type. Los endpoints existentes esperan shapes
  // específicos — adaptamos al payload encolado (que ya tiene IDs
  // resueltos al momento del enqueue).
  const body = buildEndpointBody(item);

  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Idempotency-Key": item.idempotencyKey,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    // Network error — siempre retriable.
    return {
      ok: false,
      retriable: true,
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }

  if (res.ok) return { ok: true, retriable: false, status: res.status };

  const retriable = RETRIABLE_STATUS_CODES.has(res.status);
  let errorMessage = `HTTP ${res.status}`;
  try {
    const json = (await res.json()) as { error?: string };
    if (json.error) errorMessage = json.error;
  } catch {
    // Ignore — body no era JSON, mantener el HTTP status como mensaje.
  }
  return { ok: false, retriable, status: res.status, errorMessage };
}

function buildEndpointBody(item: QueuedAction): Record<string, unknown> {
  if (item.type === "sale.create") {
    return {
      customerId: item.payload.customerId,
      customerName: item.payload.customerName,
      items: item.payload.items.map((i) => ({
        productId: i.productId,
        productName: i.productName,
        quantity: i.quantity,
        unitPrice: i.unitPrice,
      })),
      paymentMethod: item.payload.paymentMethod ?? "efectivo",
    };
  }
  if (item.type === "stock.load") {
    return {
      items: item.payload.items.map((i) => ({
        productId: i.productId,
        itemName: i.itemName,
        quantity: i.quantity,
        unitPrice: i.unitPrice,
      })),
      supplierId: item.payload.supplierId ?? null,
      supplierName: item.payload.supplierName ?? null,
      note: item.payload.note ?? null,
    };
  }
  if (item.type === "cash.movement") {
    return {
      type: item.payload.type,
      description: item.payload.description,
      amount: item.payload.amount,
      date: item.payload.date ?? null,
    };
  }
  if (item.type === "purchase-request.create") {
    return {
      supplierName: item.payload.supplierName,
      itemName: item.payload.itemName,
      quantity: item.payload.quantity,
      unitPrice: item.payload.unitPrice,
    };
  }
  if (item.type === "payment_intent.create") {
    return {
      saleId: item.payload.saleId,
      monto: item.payload.monto,
      metodo: item.payload.metodo,
    };
  }
  return {};
}
