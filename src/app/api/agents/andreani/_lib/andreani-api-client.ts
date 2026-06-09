// Andreani API client — authenticated REST wrappers.
//
// Auth (token cache, credential resolution) lives in andreani-auth.ts.
// Base URL: apis.andreani.com (prod) or apisqa.andreani.com (sandbox via ANDREANI_SANDBOX=true).
// Timeout: 12 s per request.
//
// andreaniFetch() retries ONCE on mid-call 401 (token expired between resolve and call):
//   1. Log INFO ANDREANI_TOKEN_EXPIRED_MID_CALL
//   2. Invalidate cache entry for businessId
//   3. Fetch fresh token via resolveToken()
//   4. Retry — if still 401, throw (credentials invalid, not a race condition)
//
// createOrden() idempotency:
//   Stable Idempotency-Key = SHA-256(saleId + "|" + businessId) hex.
//   Per Stripe idempotency docs (stripe.com/docs/api/idempotent_requests 2026).
//   Forwarded on every attempt including 5xx retry.

import { createHash } from "crypto";
import { cloudLog } from "@/lib/cloud-logger";
import { getCourierCredentialPort } from "@/infrastructure/courier/courier-credential.adapter";
import { resolveCredentials, resolveToken, resolveTokenWithEnv, _tokenCache } from "./andreani-auth";
import { runWithAndreaniCircuit, isAndreaniCircuitOpen } from "./andreani-circuit";
import type { AndreaniCircuitOpenError } from "./andreani-circuit";
import type {
  AndreaniAuthContext,
  AndreaniTarifaResponse,
  AndreaniOrdenResponse,
  AndreaniTrackingResponse,
} from "./types";

export { isAndreaniCircuitOpen };
export type { AndreaniCircuitOpenError } from "./andreani-circuit";

// Re-export so callers that previously imported from this module still work.
export { resolveToken, resolveTokenWithEnv };
export type { AndreaniAuthContext };
export type { ResolvedTokenWithEnv } from "./andreani-auth";

// B9_TEST_MARKER
const HTTP_TIMEOUT_MS = 12_000;

/**
 * Resolve the Andreani base URL for the API client layer.
 * Mirrors the logic in andreani-auth.ts but is kept local so callers can pass
 * the resolved environment without a round-trip through the auth module.
 * Priority: per-business credential environment > ANDREANI_SANDBOX env var > production.
 */
function getBaseUrl(credEnvironment?: "production" | "sandbox"): string {
  if (credEnvironment !== undefined) {
    return credEnvironment === "sandbox"
      ? "https://apisqa.andreani.com"
      : "https://apis.andreani.com";
  }
  return process.env.ANDREANI_SANDBOX === "true"
    ? "https://apisqa.andreani.com"
    : "https://apis.andreani.com";
}

// ── Contract code resolution ─────────────────────────────────────────────────

export interface AndreaniContractCodes {
  sucursal: string;
  domicilio: string;
  express: string;
}

/**
 * Resolve Andreani contract codes for a business.
 * Per-business credential takes priority; falls back to env vars.
 * Contract codes are account-specific alphanumeric codes assigned by Andreani
 * at commercial account provisioning — wrong codes cause API rejection.
 */
export async function resolveContractCodes(businessId: string): Promise<AndreaniContractCodes> {
  const perBusiness = await getCourierCredentialPort().loadAndreani(businessId);
  if (perBusiness) {
    return {
      domicilio: perBusiness.contratoDomicilio,
      sucursal:  perBusiness.contratoSucursal,
      express:   perBusiness.contratoExpress,
    };
  }

  const domicilio = (process.env.ANDREANI_CONTRATO_DOMICILIO ?? "").trim();
  const sucursal  = (process.env.ANDREANI_CONTRATO_SUCURSAL  ?? "").trim();
  const express   = (process.env.ANDREANI_CONTRATO_EXPRESS   ?? "").trim();

  const missing: string[] = [];
  if (!domicilio) missing.push("ANDREANI_CONTRATO_DOMICILIO");
  if (!sucursal)  missing.push("ANDREANI_CONTRATO_SUCURSAL");
  if (!express)   missing.push("ANDREANI_CONTRATO_EXPRESS");

  if (missing.length > 0) {
    throw new Error(
      `Andreani contract codes not configured for businessId=${businessId}. ` +
      `Set these env vars or connect the business's own account in Settings → Logística: ${missing.join(", ")}`,
    );
  }

  return { domicilio, sucursal, express };
}

// ── Generic fetch wrapper with auth header ───────────────────────────────────

/**
 * Execute a single HTTP request against the Andreani API.
 * businessId enables mid-call 401 retry: invalidates the cache entry and
 * retries once with a fresh token. A second 401 is thrown (credentials invalid).
 *
 * credEnvironment — when provided (from a per-business CourierCredential), overrides
 * ANDREANI_SANDBOX for endpoint selection so multi-tenant routing is correct.
 */
export async function andreaniFetch(
  path: string,
  init: RequestInit,
  ctx: AndreaniAuthContext,
  businessId?: string,
  credEnvironment?: "production" | "sandbox",
): Promise<Response> {
  const url = `${getBaseUrl(credEnvironment)}${path}`;

  const buildHeaders = (token: string): Record<string, string> => ({
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    ...(init.headers as Record<string, string> | undefined),
  });

  const doFetch = async (token: string): Promise<Response> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    try {
      return await fetch(url, { ...init, headers: buildHeaders(token), signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  };

  const res = await doFetch(ctx.accessToken);

  if (res.status === 401 && businessId) {
    const creds = await resolveCredentials(businessId);
    cloudLog({
      severity: "INFO",
      component: "A2A",
      action: "ANDREANI_TOKEN_EXPIRED_MID_CALL",
      a2a_transfer: false,
      message:
        `Andreani mid-call 401 — invalidating cache and retrying once (businessId=${businessId})`,
      data: { businessId, path },
    });
    _tokenCache.delete(creds.cacheKey);
    const freshCtx = await resolveToken(businessId);
    const retry = await doFetch(freshCtx.accessToken);
    if (retry.status === 401) {
      throw new Error(
        `Andreani 401 after token refresh for businessId=${businessId} — credentials may be invalid`,
      );
    }
    return retry;
  }

  return res;
}

// ── Andreani REST operation wrappers ─────────────────────────────────────────

export async function fetchTarifas(
  originPostal: string,
  destPostal: string,
  weightGrams: number,
  declaredValue: number,
  ctx: AndreaniAuthContext,
  businessId?: string,
  credEnvironment?: "production" | "sandbox",
): Promise<AndreaniTarifaResponse> {
  const params = new URLSearchParams({
    cpOrigen:       originPostal,
    cpDestino:      destPostal,
    bultos:         "1",
    kilos:          String(Math.ceil(weightGrams / 1000)),
    valorDeclarado: String(declaredValue),
  });
  const res = await andreaniFetch(`/v2/tarifas?${params}`, { method: "GET" }, ctx, businessId, credEnvironment);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    cloudLog({
      severity: "WARNING", component: "A2A", action: "ANDREANI_TARIFA_ERROR",
      a2a_transfer: false, message: `Andreani tarifas HTTP ${res.status}`,
      data: { originPostal, destPostal, status: res.status, body: text.slice(0, 200) },
    });
    return { tarifas: [] };
  }
  return (await res.json()) as AndreaniTarifaResponse;
}

export async function createOrden(
  payload: Record<string, unknown>,
  ctx: AndreaniAuthContext,
  businessId?: string,
  credEnvironment?: "production" | "sandbox",
): Promise<AndreaniOrdenResponse | AndreaniCircuitOpenError> {
  // Stable idempotency key: SHA-256(saleId + "|" + businessId) hex.
  const saleId = typeof payload.saleId === "string" ? payload.saleId : "";
  const idempotencyKey = createHash("sha256").update(`${saleId}|${businessId ?? ""}`).digest("hex");

  return runWithAndreaniCircuit(async () => {
    const res = await andreaniFetch(
      "/v2/ordenes",
      { method: "POST", body: JSON.stringify(payload), headers: { "Idempotency-Key": idempotencyKey } },
      ctx,
      businessId,
      credEnvironment,
    );

    const text = await res.text();
    if (!res.ok) {
      // Log full body for ops; throw sanitized message to prevent PII leaking to client.
      // Throwing here counts as a failure for the circuit breaker.
      cloudLog({
        severity: "WARNING", component: "A2A", action: "ANDREANI_ORDEN_ERROR",
        a2a_transfer: false,
        message: `Andreani createOrden failed HTTP ${res.status}`,
        data: { businessId, status: res.status, body: text.slice(0, 300) },
      });
      throw new Error(`Andreani createOrden failed (HTTP ${res.status})`);
    }
    return JSON.parse(text) as AndreaniOrdenResponse;
  });
}

export async function fetchTracking(
  trackingNumber: string,
  ctx: AndreaniAuthContext,
  businessId?: string,
  credEnvironment?: "production" | "sandbox",
): Promise<AndreaniTrackingResponse> {
  const res = await andreaniFetch(`/v2/envios/${trackingNumber}`, { method: "GET" }, ctx, businessId, credEnvironment);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Andreani tracking HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return (await res.json()) as AndreaniTrackingResponse;
}
