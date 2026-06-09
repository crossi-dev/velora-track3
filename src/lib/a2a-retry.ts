// A2A HTTP retry helper — exponential backoff with full jitter.
//
// Implements the Google SRE / Cloud Run canonical retry pattern for
// service-to-service calls that can hit cold-start latency spikes.
// Refs:
//   https://cloud.google.com/run/docs/troubleshooting (500 on cold-start)
//   https://cloud.google.com/workflows/docs/samples/workflows-error-retry-http-status
//
// Formula: delay = base * 2^(attempt-1) * Math.random()  (full jitter)
// Full jitter disperses concurrent retries uniformly, avoiding the
// synchronized thundering-herd problem that truncated backoff creates.

import { cloudLog } from "./cloud-logger";

// HTTP 500 added: Cloud Run can return 500 on cold-start before the container
// is fully ready. It is indistinguishable from a real server error at the
// caller side, so we treat it as transient and retry alongside 502/503/504.
// Ref: https://cloud.google.com/run/docs/troubleshooting
/** HTTP status codes that indicate a transient gateway / unavailability error. */
const TRANSIENT_HTTP_CODES = new Set([500, 502, 503, 504]);

// Retry config — tuned so total jittered delay ≤ 3.5 s, leaving ample
// budget inside the caller's outer LLM timeout gate.
const RETRY_MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 500; // actual delays: ~0-500, ~0-1000, ~0-2000 ms

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Wraps fetchWithTimeout with exponential backoff + full jitter retry.
 * Retries only on network errors (fetch throws) or HTTP 502/503/504.
 * 4xx and other 5xx codes propagate immediately — they are client errors
 * or non-transient server errors that a retry will not fix.
 *
 * Each attempt gets its own AbortController so per-attempt timeoutMs is
 * respected independently across the retry loop.
 *
 * @param reinitFactory  Optional factory called on every attempt (including the
 *   first) to produce a fresh RequestInit. Use this when request headers contain
 *   single-use tokens (e.g. Ed25519 JWTs with JTI replay protection) that must
 *   NOT be reused across retries. When provided, `init` is used only as the
 *   base for the first attempt and the factory overrides it on every call.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  reinitFactory?: () => RequestInit,
): Promise<Response> {
  let lastError: unknown;

  for (let attempt = 0; attempt < RETRY_MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      // Full jitter: uniform sample from [0, base * 2^(attempt-1)]
      const delayMs = Math.floor(
        RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1) * Math.random(),
      );
      cloudLog({
        severity: "WARNING",
        component: "A2A",
        action: "A2A_RETRY",
        a2a_transfer: true,
        message: `A2A call retry attempt ${attempt + 1}/${RETRY_MAX_ATTEMPTS} after transient error`,
        data: {
          attempt,
          delayMs,
          lastError: lastError instanceof Error ? lastError.message : String(lastError),
          targetUrl: url,
        },
      });
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }

    // Use a fresh init on every attempt when a factory is provided.
    // This is required for single-use tokens (JWTs with JTI) so that
    // retries do not replay an already-consumed nonce.
    const attemptInit = reinitFactory ? reinitFactory() : init;

    try {
      const res = await fetchWithTimeout(url, attemptInit, timeoutMs);
      if (TRANSIENT_HTTP_CODES.has(res.status)) {
        lastError = new Error(`HTTP ${res.status}`);
        continue; // retry on 502/503/504
      }
      if (attempt > 0) {
        cloudLog({
          severity: "INFO",
          component: "A2A",
          action: "A2A_RETRY_RECOVERED",
          a2a_transfer: true,
          message: `A2A call recovered on attempt ${attempt + 1}/${RETRY_MAX_ATTEMPTS}`,
          data: { attempt, targetUrl: url },
        });
      }
      return res;
    } catch (err) {
      lastError = err;
      // Network-level throws (ECONNREFUSED, AbortError, DNS failure, etc.)
      // are always transient — continue to next retry iteration.
    }
  }

  // All attempts exhausted — re-throw the last error as-is so callers can
  // wrap it with their own error class (e.g. A2AClientError).
  throw lastError;
}
