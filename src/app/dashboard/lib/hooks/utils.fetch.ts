"use client";

import { tLang } from "../DashboardLangContext";

export async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  ms = 15_000,
  externalSignal?: AbortSignal,
  /** Pass true to suppress the global 401→login redirect for this call.
   *  Use only when the caller handles 401 itself (e.g. employee-context fallback). */
  skipAuthRedirect = false,
): Promise<Response> {
  const controller = new AbortController();
  // Propagate external abort (user cancel) into the internal controller.
  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort();
    } else {
      externalSignal.addEventListener("abort", onExternalAbort, { once: true });
    }
  }
  // Pass a string reason so callers can distinguish an internal timeout
  // ("timeout") from a user-initiated cancel (reason is undefined or the
  // externalSignal's own reason). Check via signal.reason after catching AbortError.
  const id = setTimeout(() => controller.abort("timeout"), ms);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });

    const contentType = res.headers.get("content-type") || "";
    if (contentType.includes("text/html")) {
      throw new Error(tLang("Connection error. Check your internet and try again.", "Error de conexión al servidor. Revisá tu internet y volvé a intentar."));
    }

    // 401 — session expired. Redirect to login instead of surfacing a raw
    // "4xx" error to the user. Skipped for callers that handle 401 themselves
    // (e.g. useBusinessData's employee-context fallback path).
    if (res.status === 401 && !skipAuthRedirect && typeof window !== "undefined") {
      window.location.replace("/?session_expired=1");
      // Never resolves — the redirect navigates away before any caller processes it.
      return new Promise<Response>(() => undefined);
    }

    return res;
  } catch (error) {
    // Re-throw AbortError as-is so callers can distinguish user-cancel
    // (DOMException name "AbortError") from the watchdog timeout path.
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error;
    }
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(tLang("No server response. Check your connection and try again.", "Sin respuesta del servidor. Revisá tu conexión y volvé a intentar."));
    }
    throw error;
  } finally {
    clearTimeout(id);
    if (externalSignal) {
      externalSignal.removeEventListener("abort", onExternalAbort);
    }
  }
}

// ── Exponential backoff helper for polling loops ──────────────────────────

/**
 * Mutable backoff state for a single polling loop.
 * Create one instance per polling effect and pass it into each poll tick.
 *
 * Usage:
 *   const backoff = buildPollingBackoff();
 *   // on 429:
 *   const waitMs = backoff.next(res);
 *   await delay(waitMs);
 *   // on 200:
 *   backoff.reset();
 */
export interface PollingBackoffState {
  /** Returns delay in ms, honouring Retry-After header when present. */
  next: (res?: Response) => number;
  /** Resets the retry counter after a successful response. */
  reset: () => void;
  /** True when retries have been exhausted (caller may log a warning). */
  exhausted: boolean;
}

export function buildPollingBackoff(opts?: {
  baseMs?: number;
  maxMs?: number;
  maxRetries?: number;
}): PollingBackoffState {
  const baseMs = opts?.baseMs ?? 2_000;
  const maxMs = opts?.maxMs ?? 60_000;
  const maxRetries = opts?.maxRetries ?? 5;
  let retries = 0;

  return {
    get exhausted() { return retries >= maxRetries; },
    reset() { retries = 0; },
    next(res?: Response) {
      // Honour Retry-After header when the server sends one (in seconds).
      const retryAfterHeader = res?.headers.get("Retry-After");
      if (retryAfterHeader) {
        const secs = Number(retryAfterHeader);
        if (Number.isFinite(secs) && secs > 0) {
          retries = Math.min(retries + 1, maxRetries);
          return Math.min(secs * 1_000, maxMs);
        }
      }
      retries = Math.min(retries + 1, maxRetries);
      const cap = Math.min(maxMs, baseMs * Math.pow(2, retries - 1));
      // Full jitter: uniform random in [0, cap]
      return Math.floor(Math.random() * (cap + 1));
    },
  };
}

/**
 * Safely reads a Fetch Response as JSON.
 * - If parsing fails (SyntaxError), it results in a human-friendly fallback error.
 * - If the response is not OK, it attempts to extract a valid server 'error' message.
 * - If no server error message exists, it falls back to the provide generic message.
 * - This prevents low-level "Unexpected end of JSON" leaks to users.
 */
export async function getSafeJson<T = Record<string, unknown>>(res: Response, fallback: string): Promise<T> {
    let text = "";
    try {
        text = await res.text();
    } catch {
        throw new Error(fallback);
    }

    if (!text) {
        if (!res.ok) throw new Error(fallback);
        return {} as T;
    }

    let data: Record<string, unknown> = {};
    try {
        data = JSON.parse(text);
    } catch {
        // If it was already a 5xx/4xx error but parsing failed, use fallback
        if (!res.ok) throw new Error(fallback);
        // If it was OK but invalid JSON, it's a structural failure, let's still use a safe message
        throw new Error(tLang("Response format error. Please try again.", "Error de formato en la respuesta. Por favor, intentá de nuevo."));
    }

    if (!res.ok) {
        // Prefer server-provided message/error over the generic fallback so
        // structured errors like DEMO_LIMIT_REACHED surface their friendly text.
        // Priority: data.message (our { code, message } convention) > data.error > fallback.
        const serverMsg =
          (typeof data.message === "string" && data.message) ||
          (typeof data.error === "string" && data.error) ||
          null;
        throw new Error(serverMsg ?? fallback);
    }

    return data as T;
}
