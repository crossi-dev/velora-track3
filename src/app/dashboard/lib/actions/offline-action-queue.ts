"use client";

// Dead Man's Switch — branch offline para executeDashboardAction.
//
// Cuando el browser detecta `navigator.onLine === false` y el actionType
// es uno de los offline-eligibles (sale.create, stock-load.create,
// cash-movement.create), encolamos via offline-queue + retornamos una
// respuesta sintética. El drain (useOfflineQueueDrain) re-dispatcha al
// endpoint cuando vuelve la conexión.
//
// Feature flag `OFFLINE_QUEUE_ENABLED` se lee en RUNTIME (cada call), NO
// en module load — un toggle desde DevTools en pestaña abierta debe
// tomar efecto en la próxima mutación sin reload (corrección user
// 2026-04-28).

import {
  enqueueSaleCreate,
  enqueueStockLoad,
  enqueueCashMovement,
  enqueuePurchaseRequest,
} from "../offline-queue";
import type { ActionKey, ActionPayload, ActionResult } from "./contracts";
import type {
  SaleCreatePayload,
  StockLoadCreatePayload,
  CashMovementCreatePayload,
  PurchaseRequestCreatePayload,
} from "./contracts-payloads";

// Custom DOM event para que la UI muestre toast/banner de "guardado offline".
export const OFFLINE_QUEUED_EVENT = "velora:offline-queued";

interface OfflineQueuedDetail {
  action: ActionKey;
  idempotencyKey: string;
}

const OFFLINE_ELIGIBLE: ReadonlySet<ActionKey> = new Set<ActionKey>([
  "sale.create",
  "stock-load.create",
  "cash-movement.create",
  "purchase-request.create",
]);

const FLAG_KEY = "OFFLINE_QUEUE_ENABLED";

// Runtime read — re-evaluado en cada call. No se cachea en closure.
function isOfflineQueueEnabled(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(FLAG_KEY) !== "false";
  } catch {
    return true; // default ON si localStorage falla (modo privado, etc.)
  }
}

function isBrowserOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

function safeRandomKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    try {
      return crypto.randomUUID();
    } catch {
      /* fallthrough */
    }
  }
  return `offline_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function emitQueuedEvent(detail: OfflineQueuedDetail): void {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(new CustomEvent(OFFLINE_QUEUED_EVENT, { detail }));
  } catch {
    /* no-op */
  }
}

/**
 * Si el browser está offline + el flag está ON + el action es elegible,
 * encola el payload y retorna una ActionResult sintética. Si no
 * corresponde encolar, retorna null y el caller sigue al fetch normal.
 */
export function tryQueueOfflineAction<K extends ActionKey>(
  action: K,
  payload: ActionPayload<K>,
): ActionResult<K> | null {
  if (!OFFLINE_ELIGIBLE.has(action)) return null;
  if (!isBrowserOffline()) return null;
  if (!isOfflineQueueEnabled()) return null;

  const idempotencyKey = safeRandomKey();

  if (action === "sale.create") {
    const p = payload as SaleCreatePayload;
    enqueueSaleCreate(
      {
        customerId: p.customerId ?? null,
        customerName: p.defaultCustomerName ?? "Consumidor Final",
        businessId: p.businessId,
        total: p.total,
        paymentMethod: p.paymentMethod ?? "efectivo",
        items: p.items.map((i) => ({
          productId: i.productId,
          quantity: i.quantity,
          unitPrice: i.unitPrice,
        })),
      },
      idempotencyKey,
    );
    emitQueuedEvent({ action, idempotencyKey });
    // ActionResult<"sale.create"> tiene sale + invoice opcionales — vacío es válido.
    return {} as ActionResult<K>;
  }

  if (action === "stock-load.create") {
    const p = payload as StockLoadCreatePayload;
    enqueueStockLoad(
      {
        items: [
          {
            productId: p.productId ?? null,
            itemName: p.itemName ?? "",
            quantity: p.quantity,
            unitPrice: p.unitPrice ?? 0,
          },
        ],
        supplierId: p.supplierId ?? null,
        supplierName: p.supplierName ?? null,
        note: p.note ?? null,
        createPurchaseRequest: p.createPurchaseRequest,
        autoCreateProduct: p.autoCreateProduct,
      },
      idempotencyKey,
    );
    emitQueuedEvent({ action, idempotencyKey });
    return {} as ActionResult<K>;
  }

  if (action === "cash-movement.create") {
    const p = payload as CashMovementCreatePayload;
    enqueueCashMovement(
      {
        type: p.type,
        description: p.description,
        amount: p.amount,
        date: p.date ?? null,
      },
      idempotencyKey,
    );
    emitQueuedEvent({ action, idempotencyKey });
    return {} as ActionResult<K>;
  }

  if (action === "purchase-request.create") {
    const p = payload as PurchaseRequestCreatePayload;
    enqueuePurchaseRequest(
      {
        supplierName: p.supplierName ?? null,
        itemName: p.itemName,
        quantity: p.quantity,
        unitPrice: p.unitPrice ?? null,
      },
      idempotencyKey,
    );
    emitQueuedEvent({ action, idempotencyKey });
    // Synthetic result — requestNumber shown as "—" until drain re-sends online.
    return { id: "offline", requestNumber: "—" } as ActionResult<K>;
  }

  return null;
}
