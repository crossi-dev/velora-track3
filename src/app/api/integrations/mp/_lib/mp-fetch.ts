// MP fetch wrapper — thin adapter over mpFetchWithRetry (the canonical retry wrapper).
//
// mpFetchWithBackoff is kept for backward compatibility with existing callers in
// mp-qr.ts, mp-pos-api.ts, and webhook/topic-handler.ts. It delegates all retry
// logic to mpFetchWithRetry (429 + 5xx, exponential backoff, fresh AbortController
// per attempt).
//
// Caller signal forwarding: when the caller passes a signal (e.g. an outer timeout
// AbortController), it is composed with the per-attempt retry signal via
// AbortSignal.any([callerSignal, retrySignal]). This ensures that if the outer
// caller aborts (request cancelled, upstream timeout), the in-flight MP call is also
// cancelled immediately — even mid-backoff. AbortSignal.any is available in Node 20+
// and all modern browsers (≥90% coverage as of 2026).
//
// @deprecated — new code should call mpFetchWithRetry directly from
//   src/app/api/agents/payments/jsonrpc/_lib/mp-fetch-retry.ts

import { mpFetchWithRetry } from "@/app/api/agents/payments/jsonrpc/_lib/mp-fetch-retry";

/**
 * @deprecated Use mpFetchWithRetry from mp-fetch-retry.ts for new code.
 * Existing callers are preserved; this is a thin shim.
 */
export async function mpFetchWithBackoff(
  url: string,
  init: RequestInit,
  opts?: { maxAttempts?: number; baseDelayMs?: number; action?: string },
): Promise<Response> {
  const { signal: callerSignal, ...initWithoutSignal } = init as RequestInit & {
    signal?: AbortSignal;
  };
  const action = opts?.action ?? url.replace(/https?:\/\/[^/]+/, "").slice(0, 80);
  return mpFetchWithRetry(
    (retrySignal) => {
      // Compose caller signal with the per-attempt retry signal so either side
      // can abort the underlying fetch. AbortSignal.any is Node 20+ / modern browsers.
      const signal = callerSignal
        ? AbortSignal.any([callerSignal, retrySignal])
        : retrySignal;
      return fetch(url, { ...initWithoutSignal, signal });
    },
    action,
  );
}
