// Idempotency-key helpers extracted from useAssistantChat.ts to keep
// that file under the 400-LOC ceiling (project conventions: Code Size Contract).
// No React/state — safe to import into other hooks.

import { CHAT_EVENT } from "../chat-events";

/**
 * Generate a per-attempt idempotency key and publish it on
 * `window.__veloraIdempotencyKey` so the fetch layer
 * (`useAssistantStreaming`) can attach it as `X-Idempotency-Key`. We also
 * dispatch a `velora:idempotency-key` event for any listener that prefers
 * pub/sub over the global. The server dedupes on this key, so replays
 * from the offline queue reuse the same value to avoid double-posting a
 * sale that succeeded on a prior attempt where only the response was lost.
 */
export function publishIdempotencyKey(key: string): void {
  if (typeof window === "undefined") return;
  try {
    // custom property not declared on Window — cast required
    (window as unknown as { __veloraIdempotencyKey?: string }).__veloraIdempotencyKey = key;
    window.dispatchEvent(
      new CustomEvent(CHAT_EVENT.IDEMPOTENCY_KEY, { detail: { key } })
    );
  } catch {
    /* ignore */
  }
}

export function safeNewUuid(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    /* ignore */
  }
  return `k_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}
