// Correo Argentino API client — MiCorreo REST v1 with Bearer token auth.
//
// PROD: https://api.correoargentino.com.ar/micorreo/v1
//
// Auth flow (per MiCorreo API spec):
//   1. POST /Token → Bearer token (expires_in seconds).
//   2. POST /Users/validate → obtain customerId (done at preflight time;
//      stored in credentials so this module never calls it at quote time).
//
// Per-business token cache:
//   Key = businessId — different businesses NEVER share tokens.
//   Each Cloud Run instance holds its own in-process cache.
//   Token is refreshed TOKEN_REFRESH_BUFFER_MS before expiry to avoid races.
//
// SECURITY: password is NEVER logged, returned, or included in error messages.

import { cloudLog } from "@/lib/cloud-logger";
import { getCourierCredentialPort } from "@/infrastructure/courier/courier-credential.adapter";
import type {
  CorreoAuthContext,
  CorreoTokenResponse,
  CorreoRatesRequest,
  CorreoRateOption,
  CorreoAgency,
  CorreoTarifaOption,
} from "./types";

export const CORREO_API_BASE   = "https://api.correoargentino.com.ar/micorreo/v1";
const HTTP_TIMEOUT_MS          = 12_000;
// Refresh 30 seconds before expiry to avoid serving a near-expired token.
const TOKEN_REFRESH_BUFFER_MS  = 30_000;

// ── Per-business token cache ──────────────────────────────────────────────────

interface TokenCacheEntry {
  token: CorreoAuthContext | null;
  inflight: Promise<CorreoAuthContext> | null;
}

const _tokenCache = new Map<string, TokenCacheEntry>();

function getCacheEntry(key: string): TokenCacheEntry {
  let entry = _tokenCache.get(key);
  if (!entry) {
    entry = { token: null, inflight: null };
    _tokenCache.set(key, entry);
  }
  return entry;
}

// ── POST /Token ───────────────────────────────────────────────────────────────

/**
 * Call POST /Token and return a CorreoAuthContext.
 * SECURITY: password is sent over TLS only; never logged or included in errors.
 */
export async function fetchToken(
  username: string,
  password: string,
): Promise<CorreoAuthContext> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${CORREO_API_BASE}/Token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // SECURITY: password sent over TLS only.
      body: JSON.stringify({ username, password }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    // Do NOT include password in error message.
    throw new Error(`Correo /Token HTTP ${res.status}`);
  }

  let data: CorreoTokenResponse;
  try {
    data = (await res.json()) as CorreoTokenResponse;
  } catch {
    throw new Error("Correo /Token: respuesta inválida (no es JSON)");
  }

  if (!data.access_token) {
    throw new Error("Correo /Token: access_token ausente en la respuesta");
  }

  // Calculate expiry. expires_in is in seconds; we apply a conservative buffer.
  const ttlMs =
    typeof data.expires_in === "number" && data.expires_in > 0
      ? data.expires_in * 1_000 - TOKEN_REFRESH_BUFFER_MS
      : // Default to 55 minutes if expires_in missing (common OAuth2 TTL is 1h).
        55 * 60 * 1_000;

  return {
    accessToken: data.access_token,
    expiresAt: Date.now() + ttlMs,
  };
}

// ── resolveToken (with cache) ─────────────────────────────────────────────────

/**
 * Resolve a valid Bearer token for the given businessId.
 * Returns null when the business has no Correo credential row (graceful degradation).
 * Deduplicates concurrent cold-start fetches via the inflight promise.
 */
export async function resolveToken(businessId: string): Promise<CorreoAuthContext | null> {
  const creds = await getCourierCredentialPort().loadCorreo(businessId);
  if (!creds) return null;

  const entry = getCacheEntry(businessId);
  if (entry.token && entry.token.expiresAt - Date.now() > TOKEN_REFRESH_BUFFER_MS) {
    return entry.token;
  }
  if (entry.inflight) return entry.inflight;

  entry.inflight = fetchToken(creds.username, creds.password)
    .then((ctx) => { entry.token = ctx; entry.inflight = null; return ctx; })
    .catch((err) => { entry.inflight = null; throw err; });

  return entry.inflight;
}

// ── Generic authed fetch ─────────────────────────────────────────────────────

async function correoFetch(
  path: string,
  init: RequestInit,
  ctx: CorreoAuthContext,
): Promise<Response> {
  const url = `${CORREO_API_BASE}${path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${ctx.accessToken}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    ...(init.headers as Record<string, string> | undefined),
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, headers, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ── POST /Rates ───────────────────────────────────────────────────────────────

/**
 * Fetch shipping rate options from POST /Rates.
 * Returns empty array on non-fatal API failures so compare_rates can still
 * return results from other couriers.
 *
 * API note (2026-05-19): Correo /Rates was unreachable from public internet
 * without credentials during integration. Shape documented from official spec.
 * If Correo updates field names, align CorreoRateOption in types.ts first.
 */
export async function fetchRates(
  params: CorreoRatesRequest,
  ctx: CorreoAuthContext,
): Promise<CorreoTarifaOption[]> {
  let res: Response;
  try {
    res = await correoFetch(
      "/Rates",
      { method: "POST", body: JSON.stringify(params) },
      ctx,
    );
  } catch (err) {
    cloudLog({
      severity: "WARNING", component: "A2A", action: "CORREO_RATES_FETCH_ERROR",
      a2a_transfer: false,
      message: "Correo /Rates network error",
      data: { error: err instanceof Error ? err.message : String(err) },
    });
    return [];
  }

  if (!res.ok) {
    cloudLog({
      severity: "WARNING", component: "A2A", action: "CORREO_RATES_HTTP_ERROR",
      a2a_transfer: false,
      message: `Correo /Rates HTTP ${res.status}`,
      data: { status: res.status },
    });
    return [];
  }

  let raw: unknown;
  try {
    raw = await res.json();
  } catch {
    return [];
  }

  return parseRateOptions(raw);
}

/**
 * Parse the /Rates JSON response into canonical CorreoTarifaOption[].
 * Tolerant of missing fields — malformed entries are skipped.
 */
export function parseRateOptions(raw: unknown): CorreoTarifaOption[] {
  // Correo returns either a top-level array or { rates: [...] } or { data: [...] }.
  const items: unknown[] = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && !Array.isArray(raw)
      ? Array.isArray((raw as Record<string, unknown>).rates)
        ? (raw as Record<string, unknown>).rates as unknown[]
        : Array.isArray((raw as Record<string, unknown>).data)
          ? (raw as Record<string, unknown>).data as unknown[]
          : []
      : [];

  const options: CorreoTarifaOption[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const r = item as Partial<CorreoRateOption>;

    const price = typeof r.price === "number" && isFinite(r.price) ? r.price : null;
    if (price === null || price <= 0) continue;

    const productName = typeof r.productName === "string" && r.productName.trim()
      ? r.productName.trim()
      : typeof r.deliveryType === "string"
        ? `Correo ${r.deliveryType}`
        : "Correo Argentino";

    // Midpoint of min/max days; fall back to maxDeliveryDays, then 0.
    const minDays = typeof r.minDeliveryDays === "number" && isFinite(r.minDeliveryDays)
      ? r.minDeliveryDays : 0;
    const maxDays = typeof r.maxDeliveryDays === "number" && isFinite(r.maxDeliveryDays)
      ? r.maxDeliveryDays : minDays;
    const estimatedDays = Math.round((minDays + maxDays) / 2);

    const deliveryType = typeof r.deliveryType === "string" ? r.deliveryType.toLowerCase() : "correo";
    const productType  = typeof r.productType  === "string" ? r.productType.toLowerCase()  : "";

    options.push({
      service:      `correo_${deliveryType}${productType ? `_${productType}` : ""}`,
      serviceLabel: productName,
      priceARS:     price,
      estimatedDays,
    });
  }

  return options;
}

// ── GET /Agencies ─────────────────────────────────────────────────────────────

/**
 * Fetch Correo Argentino branches, optionally filtered by province code.
 * Returns empty array on failure (non-fatal).
 */
export async function fetchAgencies(
  ctx: CorreoAuthContext,
  provincia?: string,
): Promise<CorreoAgency[]> {
  const qs = provincia ? `?provincia=${encodeURIComponent(provincia)}` : "";
  let res: Response;
  try {
    res = await correoFetch(
      `/Agencies${qs}`,
      { method: "GET" },
      ctx,
    );
  } catch (err) {
    cloudLog({
      severity: "WARNING", component: "A2A", action: "CORREO_AGENCIES_ERROR",
      a2a_transfer: false,
      message: "Correo /Agencies network error",
      data: { error: err instanceof Error ? err.message : String(err) },
    });
    return [];
  }

  if (!res.ok) return [];

  let raw: unknown;
  try { raw = await res.json(); } catch { return []; }

  const items: unknown[] = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as Record<string, unknown>).agencies)
      ? (raw as Record<string, unknown>).agencies as unknown[]
      : [];

  return items.filter((i): i is CorreoAgency =>
    i !== null && typeof i === "object" && !Array.isArray(i),
  ) as CorreoAgency[];
}
