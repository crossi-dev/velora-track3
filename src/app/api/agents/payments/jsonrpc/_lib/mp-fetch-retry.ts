// MP fetch retry helper — extracted from mp-api-helpers.ts to keep it under
// the 300-line server/api area cap. Do not add application logic here.

import { cloudLog } from "@/lib/cloud-logger";

const MP_RETRY_MAX_ATTEMPTS = 3;
const MP_RETRY_BACKOFF_MS = [1_000, 2_000]; // waits between attempt 1→2 and 2→3
const MP_RETRY_AFTER_CAP_MS = 10_000;

// Overall deadline for the entire retry loop (all attempts + backoffs combined).
// Worst case without a deadline: 3 × 10 s per-attempt + 2 × 10 s backoff cap = 50 s.
// 30 s fits below the inner Payments ADK timeout (PAYMENTS_ADK_TIMEOUT_MS = 60 s)
// so the deadline fires before the outer ADK runner times out the call.
// Deadline propagation pattern: Google SRE Book — Addressing Cascading Failures
//   https://sre.google/sre-book/addressing-cascading-failures/
const MP_RETRY_TOTAL_DEADLINE_MS = 30_000;

// SDK error shape: RestClient throws `await response.json()` on non-2xx.
// MP rate-limit responses include a `status` field in the JSON body (e.g. 429).
// Reference: node_modules/mercadopago/dist/utils/restClient/index.js line 134.
function isSdkRetryable(err: unknown): boolean {
  if (err && typeof err === "object") {
    const status = (err as Record<string, unknown>).status;
    if (typeof status === "number") return status === 429 || status >= 500;
  }
  return false;
}

// Wraps a mercadopago SDK call in retry-with-backoff for transient 429 / 5xx errors.
// The official SDK (v3) retries ONLY 5xx — it does NOT retry 429 (status < 500
// exits the SDK loop immediately). This wrapper restores the prior mpFetchWithRetry
// behavior: 429 is retried up to MP_RETRY_MAX_ATTEMPTS total with full jitter and
// the 30 s overall deadline cap.
//
// Mirrors mpFetchWithRetry constants exactly so the two paths behave identically.
export async function mpSdkWithRetry<T>(
  callSdk: () => Promise<T>,
  action: string,
): Promise<T> {
  const deadlineTimer = { id: 0 as unknown as ReturnType<typeof setTimeout>, fired: false };
  const deadlinePromise = new Promise<never>((_, reject) => {
    deadlineTimer.id = setTimeout(() => {
      deadlineTimer.fired = true;
      reject(new DOMException("MP SDK retry deadline exceeded", "AbortError"));
    }, MP_RETRY_TOTAL_DEADLINE_MS);
  });

  try {
    for (let attempt = 1; attempt <= MP_RETRY_MAX_ATTEMPTS; attempt++) {
      if (deadlineTimer.fired) {
        throw new DOMException("MP SDK retry deadline exceeded", "AbortError");
      }

      try {
        // Race the SDK call against the overall deadline.
        return await Promise.race([callSdk(), deadlinePromise]);
      } catch (err) {
        const isLast = attempt === MP_RETRY_MAX_ATTEMPTS;
        if (isLast || !isSdkRetryable(err)) throw err;

        const backoffMs =
          MP_RETRY_BACKOFF_MS[attempt - 1] ?? MP_RETRY_BACKOFF_MS[MP_RETRY_BACKOFF_MS.length - 1];
        const errStatus = (err as Record<string, unknown>).status;
        cloudLog({
          severity: "INFO",
          component: "A2A",
          action: "MP_SDK_RETRY",
          a2a_transfer: false,
          message: `MP SDK retry: action=${action} attempt=${attempt} status=${errStatus} backoffMs=${backoffMs}`,
          data: { action, attempt, status: errStatus, backoffMs },
        });

        // Full jitter — prevents correlated retry storms across Cloud Run instances.
        const jitteredMs = Math.random() * backoffMs;
        await Promise.race([
          new Promise<void>((resolve) => setTimeout(resolve, jitteredMs)),
          deadlinePromise,
        ]);
      }
    }
    // Unreachable — loop always throws or returns, satisfies TS exhaustiveness.
    throw new DOMException("MP SDK retry loop exhausted", "AbortError");
  } finally {
    clearTimeout(deadlineTimer.id);
  }
}

// Wraps a fetch factory in retry-with-backoff for transient 429 / 5xx errors.
// Only 429 and 5xx are retried — other 4xx are real errors and returned immediately.
// Respects the Retry-After response header when present (capped at 10 s).
//
// Each attempt gets its own AbortController (10 s budget). The factory receives
// a fresh signal per attempt so a slow 429 + backoff cannot exhaust the shared
// signal before the next attempt begins.
//
// An overall deadline AbortController (30 s) is composed with each per-attempt
// signal so the loop cannot run unbounded across retries + backoffs.
export async function mpFetchWithRetry(
  makeFetch: (signal: AbortSignal) => Promise<Response>,
  action: string,
): Promise<Response> {
  const deadlineController = new AbortController();
  const deadlineTimer = setTimeout(() => deadlineController.abort(), MP_RETRY_TOTAL_DEADLINE_MS);

  try {
    let lastResponse: Response | null = null;
    for (let attempt = 1; attempt <= MP_RETRY_MAX_ATTEMPTS; attempt++) {
      // Abort early if the overall deadline already fired (e.g. during a backoff sleep).
      if (deadlineController.signal.aborted) {
        throw new DOMException("MP fetch retry deadline exceeded", "AbortError");
      }

      const attemptController = new AbortController();
      const attemptTimer = setTimeout(() => attemptController.abort(), MP_RETRY_AFTER_CAP_MS);
      // Compose per-attempt signal with overall deadline so either side can abort.
      const signal = AbortSignal.any([deadlineController.signal, attemptController.signal]);

      let res: Response;
      try {
        res = await makeFetch(signal);
      } finally {
        clearTimeout(attemptTimer);
      }
      const isRetryable = res.status === 429 || res.status >= 500;
      if (!isRetryable || attempt === MP_RETRY_MAX_ATTEMPTS) {
        return res;
      }

      // Determine wait time: prefer Retry-After header (capped), else exponential backoff.
      // RFC 7231 §7.1.3: Retry-After can be an integer (seconds) OR an HTTP-date string.
      // parseInt on a date string returns NaN → Math.min(NaN*1000, cap) = NaN →
      // setTimeout(NaN) resolves immediately, turning 3 retries into an instant storm.
      // Guard: only use the header value when it parses to a finite positive number.
      const retryAfterHeader = res.headers.get("Retry-After");
      const retryAfterSecs = retryAfterHeader ? parseInt(retryAfterHeader, 10) : NaN;
      const backoffMs = Number.isFinite(retryAfterSecs) && retryAfterSecs > 0
        ? Math.min(retryAfterSecs * 1_000, MP_RETRY_AFTER_CAP_MS)
        : (MP_RETRY_BACKOFF_MS[attempt - 1] ?? MP_RETRY_BACKOFF_MS[MP_RETRY_BACKOFF_MS.length - 1]);

      cloudLog({
        severity: "INFO",
        component: "A2A",
        action: "MP_API_RETRY",
        a2a_transfer: false,
        message: `MP API retry: action=${action} attempt=${attempt} status=${res.status} backoffMs=${backoffMs}`,
        data: { action, attempt, status: res.status, backoffMs },
      });

      lastResponse = res;
      // Full jitter (Google Cloud WAF 2026 resilience pillar): randomise backoff
      // to prevent correlated retry storms when multiple instances back off together.
      const jitteredMs = Math.random() * backoffMs;
      await new Promise<void>((resolve) => setTimeout(resolve, jitteredMs));
    }
    // Unreachable — loop always returns, but satisfies TS exhaustiveness.
    return lastResponse!;
  } finally {
    clearTimeout(deadlineTimer);
  }
}
