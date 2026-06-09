"use client";

import { CHAT_EVENT } from "./chat-events";
import {
  OFFLINE_QUEUE_KEY,
  type QueuedAction,
  type QueueEnvelope,
  type ChatPayload,
  type OfflineSalePayload,
  type OfflineStockLoadPayload,
  type OfflineCashMovementPayload,
  type OfflinePurchaseRequestPayload,
  type OfflinePaymentIntentPayload,
} from "./offline-queue.types";

export function isBrowser(): boolean {
  return typeof window !== "undefined" && typeof localStorage !== "undefined";
}

export function safeUuid(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch { /* ignore */ }
  return `q_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

// Cross-tab concurrency tracking — module-scoped, single-tab only.
let storageListenerAttached = false;
let _lastSeenVersion = 0;

export function ensureStorageListener(): void {
  if (!isBrowser() || storageListenerAttached) return;
  storageListenerAttached = true;
  window.addEventListener("storage", (e) => {
    if (e.key === OFFLINE_QUEUE_KEY || e.key === null) {
      _lastSeenVersion = -1;
    }
  });
}

export function readEnvelope(): QueueEnvelope {
  if (!isBrowser()) return { version: 0, items: [] };
  ensureStorageListener();
  try {
    const raw = localStorage.getItem(OFFLINE_QUEUE_KEY);
    if (!raw) return { version: 0, items: [] };
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return { version: 0, items: parsed.filter(isValidQueuedAction) };
    }
    if (parsed && typeof parsed === "object") {
      const env = parsed as { version?: unknown; items?: unknown };
      const version = typeof env.version === "number" ? env.version : 0;
      const items = Array.isArray(env.items) ? env.items.filter(isValidQueuedAction) : [];
      return { version, items };
    }
    return { version: 0, items: [] };
  } catch {
    return { version: 0, items: [] };
  }
}

const VALID_QUEUED_TYPES = new Set([
  "assistant.chat",
  "sale.create",
  "stock.load",
  "cash.movement",
  "purchase-request.create",
  "payment_intent.create",
]);

function hasValidPayloadForType(type: string, payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  if (type === "assistant.chat") return typeof (payload as ChatPayload).text === "string";
  if (type === "sale.create") {
    const p = payload as OfflineSalePayload;
    return Array.isArray(p.items) && p.items.length > 0;
  }
  if (type === "stock.load") {
    const p = payload as OfflineStockLoadPayload;
    return Array.isArray(p.items) && p.items.length > 0;
  }
  if (type === "cash.movement") {
    const p = payload as OfflineCashMovementPayload;
    return typeof p.type === "string" && typeof p.amount === "number";
  }
  if (type === "purchase-request.create") {
    const p = payload as OfflinePurchaseRequestPayload;
    return typeof p.itemName === "string" && typeof p.quantity === "number";
  }
  if (type === "payment_intent.create") {
    const p = payload as OfflinePaymentIntentPayload;
    return typeof p.monto === "number" && typeof p.metodo === "string";
  }
  return false;
}

export function isValidQueuedAction(entry: unknown): entry is QueuedAction {
  if (!entry || typeof entry !== "object") return false;
  const a = entry as Partial<QueuedAction>;
  if (typeof a.id !== "string") return false;
  if (typeof a.type !== "string" || !VALID_QUEUED_TYPES.has(a.type)) return false;
  if (typeof a.idempotencyKey !== "string") return false;
  if (typeof a.queuedAt !== "number") return false;
  if (typeof a.attempts !== "number") return false;
  return hasValidPayloadForType(a.type, a.payload);
}

export function readAll(): QueuedAction[] {
  const env = readEnvelope();
  _lastSeenVersion = env.version;
  return env.items;
}

export function commit(mutate: (current: QueuedAction[]) => QueuedAction[]): QueuedAction[] {
  if (!isBrowser()) return mutate([]);
  ensureStorageListener();
  let attempts = 0;
  while (attempts < 3) {
    const envBefore = readEnvelope();
    const next = mutate(envBefore.items);
    const envNow = readEnvelope();
    if (envNow.version !== envBefore.version) {
      // Another tab wrote concurrently. On the last attempt, bail rather than
      // clobbering their write with our stale envelope.
      if (attempts >= 2) return mutate(readEnvelope().items);
      attempts += 1;
      continue;
    }
    const nextEnv: QueueEnvelope = { version: envNow.version + 1, items: next };
    const wrote = writeEnvelope(nextEnv);
    if (wrote) {
      _lastSeenVersion = nextEnv.version;
      return next;
    }
    attempts += 1;
  }
  return mutate(readEnvelope().items);
}

/** Strip plaintext user-typed text from assistant.chat payloads before persisting.
 * The drain already skips items with empty text (line 168), so queued chat
 * messages are silently discarded on reconnect rather than replaying stale
 * free-text. No encryption needed — the PII just isn't stored. */
function scrubForStorage(env: QueueEnvelope): QueueEnvelope {
  const scrubbedItems = env.items.map((item) => {
    if (item.type !== "assistant.chat") return item;
    return { ...item, payload: { ...item.payload, text: "" } };
  });
  return { ...env, items: scrubbedItems };
}

export function writeEnvelope(env: QueueEnvelope): boolean {
  if (!isBrowser()) return false;
  try {
    localStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(scrubForStorage(env)));
    return true;
  } catch (err) {
    const isQuota =
      (err && typeof err === "object" && "name" in err &&
        /quota/i.test(String((err as { name?: unknown }).name ?? ""))) ||
      /quota/i.test(String(err));
    if (isQuota && env.items.length > 0) {
      const drop = Math.max(1, Math.ceil(env.items.length * 0.25));
      const pruned: QueueEnvelope = { version: env.version, items: env.items.slice(drop) };
      try {
        localStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(pruned));
        console.error("[offline-queue] Quota exceeded — evicted oldest", drop, "item(s)", err);
        try {
          window.dispatchEvent(new CustomEvent(CHAT_EVENT.OFFLINE_QUEUE_QUOTA, {
            detail: { evicted: drop, remaining: pruned.items.length },
          }));
        } catch { /* ignore */ }
        return true;
      } catch (retryErr) {
        console.error("[offline-queue] Quota retry failed:", retryErr);
        try {
          window.dispatchEvent(new CustomEvent(CHAT_EVENT.OFFLINE_QUEUE_QUOTA, {
            detail: { evicted: 0, remaining: env.items.length, fatal: true },
          }));
        } catch { /* ignore */ }
        return false;
      }
    }
    console.error("[offline-queue] No se pudo guardar la cola offline:", err);
    return false;
  }
}
