// Custom-event names dispatched on `window` between assistant-chat sub-hooks.
// Centralizing keeps the contract typo-safe — a rename here propagates via
// TypeScript instead of leaving a silently-orphaned listener.

export const CHAT_EVENT = {
  /** Dispatched after a product.create that was triggered by a sale flow,
   *  carrying the original sale text so the chat can re-dispatch it. */
  RETRY_SALE: "velora:retry-sale",
  /** Dispatched on transient network errors so unrelated UI can react
   *  (e.g. show a "Retry" button) without coupling to the chat hook. */
  NETWORK_ERROR: "velora:network-error",
  /** Dispatched when an offline-queued message exceeds its retry cap. */
  OFFLINE_QUEUE_FAILED: "velora:offline-queue-failed",
  /** Dispatched whenever the offline queue grows/shrinks/clears so any
   *  subscribed UI can refresh. */
  OFFLINE_QUEUE_CHANGED: "velora:offline-queue-changed",
  /** Dispatched when localStorage quota blocks a queue write. */
  OFFLINE_QUEUE_QUOTA: "velora:offline-queue-quota",
  /** Listener entry-point for "retry the last failed action" UI button. */
  RETRY_LAST_FAILED: "velora:retry-last-failed",
  /** Idempotency-key publication for downstream fetch interceptors. */
  IDEMPOTENCY_KEY: "velora:idempotency-key",
} as const;

export type ChatEventName = typeof CHAT_EVENT[keyof typeof CHAT_EVENT];
