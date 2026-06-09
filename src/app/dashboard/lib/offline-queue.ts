"use client";

import { CHAT_EVENT } from "./chat-events";
import { commit, readAll, isBrowser, safeUuid } from "./offline-queue.storage";
import {
  OFFLINE_QUEUE_KEY,
  type ChatPayload,
  type OfflineSalePayload,
  type OfflineStockLoadPayload,
  type OfflineCashMovementPayload,
  type OfflinePurchaseRequestPayload,
  type OfflinePaymentIntentPayload,
  type QueuedAction,
} from "./offline-queue.types";

// Re-export types and constant for backward-compat — importers don't need to change.
export type {
  ChatPayload,
  OfflineSalePayload,
  OfflineStockLoadPayload,
  OfflineCashMovementPayload,
  OfflinePurchaseRequestPayload,
  OfflinePaymentIntentPayload,
  QueuedAction,
  QueuedActionPayload,
} from "./offline-queue.types";
export { OFFLINE_QUEUE_KEY } from "./offline-queue.types";

const MAX_QUEUE_SIZE = 50;
const MAX_ATTEMPTS = 3;

// ── Public API ─────────────────────────────────────────────────────────

/** Append an assistant.chat action. Evicts oldest when over capacity. */
export function enqueue(input: {
  type: "assistant.chat";
  payload: ChatPayload;
  idempotencyKey?: string;
}): QueuedAction {
  const entry: QueuedAction = {
    type: input.type,
    id: safeUuid(),
    payload: input.payload,
    idempotencyKey: input.idempotencyKey ?? safeUuid(),
    queuedAt: Date.now(),
    attempts: 0,
  };
  commit((items) => {
    const next = [...items, entry];
    while (next.length > MAX_QUEUE_SIZE) next.shift();
    return next;
  });
  return entry;
}

export function enqueueSaleCreate(payload: OfflineSalePayload, idempotencyKey?: string): QueuedAction {
  const entry: QueuedAction = {
    type: "sale.create",
    id: safeUuid(),
    payload,
    idempotencyKey: idempotencyKey ?? safeUuid(),
    queuedAt: Date.now(),
    attempts: 0,
  };
  commit((items) => {
    const next = [...items, entry];
    while (next.length > MAX_QUEUE_SIZE) next.shift();
    return next;
  });
  return entry;
}

export function enqueueStockLoad(payload: OfflineStockLoadPayload, idempotencyKey?: string): QueuedAction {
  const entry: QueuedAction = {
    type: "stock.load",
    id: safeUuid(),
    payload,
    idempotencyKey: idempotencyKey ?? safeUuid(),
    queuedAt: Date.now(),
    attempts: 0,
  };
  commit((items) => {
    const next = [...items, entry];
    while (next.length > MAX_QUEUE_SIZE) next.shift();
    return next;
  });
  return entry;
}

export function enqueueCashMovement(payload: OfflineCashMovementPayload, idempotencyKey?: string): QueuedAction {
  const entry: QueuedAction = {
    type: "cash.movement",
    id: safeUuid(),
    payload,
    idempotencyKey: idempotencyKey ?? safeUuid(),
    queuedAt: Date.now(),
    attempts: 0,
  };
  commit((items) => {
    const next = [...items, entry];
    while (next.length > MAX_QUEUE_SIZE) next.shift();
    return next;
  });
  return entry;
}

export function enqueuePurchaseRequest(payload: OfflinePurchaseRequestPayload, idempotencyKey?: string): QueuedAction {
  const entry: QueuedAction = {
    type: "purchase-request.create",
    id: safeUuid(),
    payload,
    idempotencyKey: idempotencyKey ?? safeUuid(),
    queuedAt: Date.now(),
    attempts: 0,
  };
  commit((items) => {
    const next = [...items, entry];
    while (next.length > MAX_QUEUE_SIZE) next.shift();
    return next;
  });
  return entry;
}

export function enqueuePaymentIntentCreate(payload: OfflinePaymentIntentPayload, idempotencyKey?: string): QueuedAction {
  const entry: QueuedAction = {
    type: "payment_intent.create",
    id: safeUuid(),
    payload,
    idempotencyKey: idempotencyKey ?? safeUuid(),
    queuedAt: Date.now(),
    attempts: 0,
  };
  commit((items) => {
    const next = [...items, entry];
    while (next.length > MAX_QUEUE_SIZE) next.shift();
    return next;
  });
  return entry;
}

/** Removes and returns the head of the queue. */
export function pop(): QueuedAction | null {
  let head: QueuedAction | null = null;
  commit((items) => {
    const copy = [...items];
    head = copy.shift() ?? null;
    return copy;
  });
  return head;
}

/** Snapshot of the full queue in order. */
export function getAll(): QueuedAction[] {
  return readAll();
}

/** Returns the current queue length. */
export function size(): number {
  return readAll().length;
}

/** Increment attempts on the head item (id-matched). */
export function bumpAttempts(item: QueuedAction): void {
  commit((items) => {
    if (items.length === 0) return items;
    const copy = [...items];
    if (copy[0].id === item.id) {
      copy[0] = { ...copy[0], attempts: copy[0].attempts + 1 };
    }
    return copy;
  });
}

/** Mark the head item as failed (sets lastError for debugging). */
export function markFailed(item: QueuedAction, error: string): void {
  commit((items) => {
    if (items.length === 0) return items;
    const copy = [...items];
    if (copy[0].id === item.id) {
      copy[0] = { ...copy[0], lastError: error };
    }
    return copy;
  });
}

/** Maximum replay attempts before an item is considered dead. */
export const MAX_REPLAY_ATTEMPTS = MAX_ATTEMPTS;

/** Clears the entire queue. */
export function clear(): void {
  if (!isBrowser()) return;
  try {
    localStorage.removeItem(OFFLINE_QUEUE_KEY);
  } catch { /* ignore */ }
}

// ── Drain lock ─────────────────────────────────────────────────────────

let drainLocked = false;

export function tryAcquireDrainLock(): boolean {
  if (drainLocked) return false;
  drainLocked = true;
  return true;
}

export function releaseDrainLock(): void {
  drainLocked = false;
}

// ── Subscriptions ──────────────────────────────────────────────────────

export function subscribe(listener: () => void): () => void {
  if (!isBrowser()) return () => {};
  const storageHandler = (e: StorageEvent) => {
    if (e.key === OFFLINE_QUEUE_KEY || e.key === null) listener();
  };
  const customHandler = () => listener();
  window.addEventListener("storage", storageHandler);
  window.addEventListener(CHAT_EVENT.OFFLINE_QUEUE_CHANGED, customHandler);
  return () => {
    window.removeEventListener("storage", storageHandler);
    window.removeEventListener(CHAT_EVENT.OFFLINE_QUEUE_CHANGED, customHandler);
  };
}

/** Dispatches a same-tab change notification so subscribers update live. */
export function notifyChanged(): void {
  if (!isBrowser()) return;
  try {
    window.dispatchEvent(new Event(CHAT_EVENT.OFFLINE_QUEUE_CHANGED));
  } catch { /* ignore */ }
}
