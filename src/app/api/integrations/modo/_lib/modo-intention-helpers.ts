// MODO payment intention helpers — split from modo-api-helpers.ts to stay under 300 lines.
// Handles payment intention creation and status fetching.
//
// See modo-api-helpers.ts for base URL, auth, and credential loading.

import { cloudLog } from "@/lib/cloud-logger";
import { MODO_API_BASE, MODO_HTTP_TIMEOUT_MS, MODO_TERMINAL_ID } from "./modo-api-helpers";

// ── Retry helper ──────────────────────────────────────────────────────────────
// Retries on 429 and 5xx transient errors with exponential backoff.
// Each attempt uses a fresh AbortController so the timeout budget resets.
// Mirrors mpFetchWithBackoff (mp-fetch.ts) — same pattern, same contract.
async function modoFetchWithRetry(
  url: string,
  init: Omit<RequestInit, "signal">,
  opts?: { maxAttempts?: number; baseDelayMs?: number },
): Promise<Response> {
  const maxAttempts = opts?.maxAttempts ?? 3;
  const baseDelayMs = opts?.baseDelayMs ?? 1_000;
  let lastResponse: Response | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), MODO_HTTP_TIMEOUT_MS);
    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      clearTimeout(timeout);
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt === maxAttempts) return res;
      lastResponse = res;
      // RFC 7231 §7.1.3: Retry-After can be an integer (seconds) OR an HTTP-date string.
      // parseFloat on a date string returns NaN → NaN * 1000 = NaN → setTimeout(NaN)
      // fires immediately, creating an instant retry storm. Guard: only use the header
      // value when it parses to a finite positive number (mirrors mp-fetch-retry.ts fix).
      const retryAfterHeader = res.headers.get("retry-after");
      const retryAfterSecs = retryAfterHeader ? parseInt(retryAfterHeader, 10) : NaN;
      const backoffMs = Number.isFinite(retryAfterSecs) && retryAfterSecs > 0
        ? retryAfterSecs * 1_000
        : baseDelayMs * Math.pow(2, attempt - 1);
      // Full jitter (Google Cloud WAF 2026 resilience pillar): randomise the delay
      // to prevent correlated retry storms when multiple instances back off together.
      const jitteredDelay = Math.random() * Math.min(backoffMs, 5_000);
      await new Promise((r) => setTimeout(r, jitteredDelay));
    } catch (err) {
      clearTimeout(timeout);
      // Network / timeout errors: retry unless last attempt.
      // Full jitter to prevent correlated storms across concurrent instances.
      if (attempt === maxAttempts) throw err;
      const backoff = baseDelayMs * Math.pow(2, attempt - 1);
      const jitteredDelay = Math.random() * Math.min(backoff, 5_000);
      await new Promise((r) => setTimeout(r, jitteredDelay));
    }
  }
  // Unreachable — loop always returns or throws above. Satisfy type-checker.
  return lastResponse!;
}

// ── Payment intention creation ────────────────────────────────────────────────

export interface ModoCreateIntentionParams {
  businessId: string;
  storeId: string;
  accessToken: string;
  amountARS: number;
  description: string;
  /** Stable external reference — we use "{businessId}:{paymentIntentId}" */
  externalIntentionId: string;
  fetchImpl?: typeof fetch;
}

export interface ModoIntentionCreated {
  intentionId: string;
  /** MODO embeds the checkout URL in the response; field name not confirmed — see gap note. */
  checkoutUrl: string | null;
}

/**
 * Creates a MODO payment intention.
 * POST /ecommerce/payment-intention
 *
 * GAP: the response field that carries the redirect/checkout URL is not confirmed
 * from public docs. WP plugin renders an in-page modal via their JS SDK using the
 * intention ID — it does NOT extract a plain checkout URL. We attempt to read
 * common candidates (checkoutUrl, url, redirectUrl, payment_url, checkout_url) and
 * fall back to constructing a MODO checkout URL from the intention ID.
 */
export async function createModoIntention(
  params: ModoCreateIntentionParams,
): Promise<ModoIntentionCreated | { error: string; detail: unknown }> {
  const { businessId, storeId, accessToken, amountARS, description, externalIntentionId } = params;
  const fetchImpl = params.fetchImpl ?? fetch;

  const body = {
    productName: description,
    price: amountARS,
    quantity: 1,
    // terminalId: WP plugin uses "123", but MODO docs don't specify. "1" for prod.
    terminalId: MODO_TERMINAL_ID,
    storeId,
    externalIntentionId,
    currency: "ARS",
  };

  const intentionUrl = `${MODO_API_BASE}/ecommerce/payment-intention`;
  const intentionInit = {
    method: "POST" as const,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify(body),
  };

  try {
    // Use retry when running against the real MODO API; bypass retry when a
    // test stub is injected via fetchImpl so tests stay deterministic.
    const res = fetchImpl !== fetch
      ? await fetchImpl(intentionUrl, intentionInit)
      : await modoFetchWithRetry(intentionUrl, intentionInit);
    const text = await res.text();
    let parsed: unknown = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }

    if (!res.ok) {
      cloudLog({
        severity: "ERROR",
        component: "A2A",
        action: "MODO_INTENTION_CREATE_FAILED",
        a2a_transfer: false,
        message: `MODO /ecommerce/payment-intention POST failed status=${res.status}`,
        data: { businessId, status: res.status, externalIntentionId },
      });
      return { error: "modo_api_error", detail: { status: res.status, body: parsed ?? text.slice(0, 500) } };
    }

    const obj = parsed as Record<string, unknown>;
    // WP plugin reads `status === "CREATED"` and uses `id` as the intention ID.
    if (typeof obj?.status === "string" && obj.status !== "CREATED") {
      cloudLog({
        severity: "WARNING",
        component: "A2A",
        action: "MODO_INTENTION_NOT_CREATED",
        a2a_transfer: false,
        message: `MODO payment intention status != CREATED: ${String(obj.status)}`,
        data: { businessId, status: obj.status },
      });
      return { error: "modo_intention_not_created", detail: { status: obj.status } };
    }

    const intentionId = typeof obj.id === "string" ? obj.id : null;
    if (!intentionId) {
      cloudLog({
        severity: "ERROR",
        component: "A2A",
        action: "MODO_INTENTION_NO_ID",
        a2a_transfer: false,
        message: "MODO /ecommerce/payment-intention: respuesta sin id",
        data: { businessId, body: obj },
      });
      return { error: "bad_shape", detail: { body: obj } };
    }

    // GAP: MODO's frontend SDK renders a modal — it doesn't use a plain checkout URL.
    // For Velora's link-sharing use case, we construct a deep-link to MODO's checkout.
    // Known candidates tried first; fallback to constructed URL.
    const candidateUrl =
      typeof obj.checkoutUrl === "string" ? obj.checkoutUrl :
      typeof obj.url === "string" ? obj.url :
      typeof obj.redirectUrl === "string" ? obj.redirectUrl :
      typeof obj.payment_url === "string" ? obj.payment_url :
      typeof obj.checkout_url === "string" ? obj.checkout_url :
      null;

    // UNCERTAINTY: The constructed fallback URL below is a best-approximation
    // derived from MODO's WooCommerce plugin source. The actual checkout URL
    // format for consumer deep-linking has NOT been confirmed with MODO dev relations.
    // The WP plugin renders an in-page modal (does not share a plain URL at all).
    //
    // BLOCKED-EXTERNAL: contact desarrolladores@modo.com.ar to:
    //   1. Confirm (or correct) the consumer-facing checkout URL pattern.
    //   2. Obtain sandbox credentials for integration testing.
    //   3. Get access to official API documentation beyond the WP plugin source.
    // Status as of 2026-05-23: MODO contact still pending response. See the
    // module-level BLOCKED-EXTERNAL block in modo-api-helpers.ts for full context.
    //
    // If `candidateUrl` is populated by the API response, that value is preferred
    // and this constructed fallback is never used.
    const constructedUrl = `https://merchants.modo.com.ar/checkout/${intentionId}`;
    const checkoutUrl = candidateUrl ?? constructedUrl;

    // Log when we fall back to the constructed URL so Cloud Logging surfaces it.
    if (!candidateUrl) {
      cloudLog({
        severity: "WARNING",
        component: "A2A",
        action: "MODO_CHECKOUT_URL_CONSTRUCTED",
        a2a_transfer: false,
        message:
          "MODO API did not return a checkout URL — using constructed fallback. " +
          "URL pattern unconfirmed; contact desarrolladores@modo.com.ar for spec.",
        data: { businessId, intentionId, constructedUrl },
      });
    }

    cloudLog({
      severity: "INFO",
      component: "A2A",
      action: "MODO_INTENTION_CREATED",
      a2a_transfer: false,
      message: "MODO payment intention creada",
      data: { businessId, intentionId, externalIntentionId, urlSource: candidateUrl ? "api_response" : "constructed" },
    });

    return { intentionId, checkoutUrl };
  } catch (err) {
    cloudLog({
      severity: "ERROR",
      component: "A2A",
      action: "MODO_INTENTION_ERROR",
      a2a_transfer: false,
      message: "MODO /ecommerce/payment-intention: error de red o timeout",
      data: { businessId, error: err instanceof Error ? err.message : String(err) },
    });
    return { error: "modo_network_error", detail: err instanceof Error ? err.message : String(err) };
  }
}

// ── Payment status ────────────────────────────────────────────────────────────

export type ModoIntentionStatus = "ACCEPTED" | "REJECTED" | "CANCELLED" | "CREATED" | string;

export interface ModoIntentionStatusResult {
  intentionId: string;
  status: ModoIntentionStatus;
  raw: unknown;
}

/**
 * Fetches MODO payment intention status.
 * GET /ecommerce/payment-intention/{intentionId}
 */
export async function getModoIntentionStatus(params: {
  businessId: string;
  intentionId: string;
  accessToken: string;
  fetchImpl?: typeof fetch;
}): Promise<ModoIntentionStatusResult | { error: string; detail: unknown }> {
  const { businessId: _businessId, intentionId, accessToken } = params;
  const fetchImpl = params.fetchImpl ?? fetch;
  const statusUrl = `${MODO_API_BASE}/ecommerce/payment-intention/${encodeURIComponent(intentionId)}`;
  const statusInit = { method: "GET" as const, headers: { Authorization: `Bearer ${accessToken}` } };

  try {
    const res = fetchImpl !== fetch
      ? await fetchImpl(statusUrl, statusInit)
      : await modoFetchWithRetry(statusUrl, statusInit);
    const text = await res.text();
    let parsed: unknown = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }

    if (!res.ok) {
      return {
        error: "modo_status_error",
        detail: { status: res.status, body: parsed ?? text.slice(0, 200) },
      };
    }

    const obj = parsed as Record<string, unknown>;
    const status = typeof obj?.status === "string" ? obj.status : "unknown";
    return { intentionId, status, raw: obj };
  } catch (err) {
    return {
      error: "modo_network_error",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

