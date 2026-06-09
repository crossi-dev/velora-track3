// OCA API client — ApiPostal REST wrapper with bearer token auth + per-business cache.
//
// ApiPostal (REST/JSON): https://www1.oca.com.ar/ApiPostal/
//   Auth: POST LoginController/loginSigma → bearer token (5-minute TTL).
//   Used for: tracking (EstadoActual, HistorialSeguimiento), branches (ObtenerSucursalOca),
//             piece creation (CrearPieza).
//
// e-Pak operations (tarifa quotes and order creation) live in oca-epak-client.ts.
// This file re-exports them for convenience so callers import from one place.
//
// Per-business token cache:
//   Key = businessId — ensures different businesses never share tokens.
//   Each Cloud Run instance holds its own token map and refreshes independently.
//
// SECURITY: password is NEVER logged, returned, or included in error messages.

import { cloudLog } from "@/lib/cloud-logger";
import { getCourierCredentialPort } from "@/infrastructure/courier/courier-credential.adapter";
import { withOcaCircuit } from "./oca-circuit";
import type {
  OcaAuthContext,
  OcaLoginResponse,
  OcaEstadoActualResponse,
  OcaHistorialResponse,
  OcaSucursal,
} from "./types";

// Re-export e-Pak functions so adapter can import from one place.
export { fetchTarifas, crearEnvio } from "./oca-epak-client";

export const APIPOSTAL_BASE    = "https://www1.oca.com.ar/ApiPostal";
const HTTP_TIMEOUT_MS          = 12_000;
// Token TTL at OCA is 5 minutes; refresh 30s before expiry to avoid races.
const TOKEN_REFRESH_BUFFER_MS  = 30_000;

// ── Per-business token cache ──────────────────────────────────────────────────

interface TokenCacheEntry {
  token: OcaAuthContext | null;
  inflight: Promise<OcaAuthContext> | null;
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

// ── loginSigma ────────────────────────────────────────────────────────────────

/**
 * Call OCA ApiPostal loginSigma and return a 5-minute bearer token.
 * SECURITY: password is sent over TLS only; never logged or included in errors.
 */
export async function loginSigma(
  usuario: string,
  password: string,
): Promise<OcaAuthContext> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${APIPOSTAL_BASE}/LoginController/loginSigma`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // SECURITY: password goes over TLS only.
      body: JSON.stringify({ usuario, password }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`OCA loginSigma HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = (await res.json()) as OcaLoginResponse;
  if (!data.success || typeof data.result !== "string" || !data.result) {
    throw new Error(`OCA loginSigma returned success=false or empty token: ${data.message ?? "no message"}`);
  }
  // OCA tokens are valid 5 minutes; store with a conservative 4.5-minute window.
  return { accessToken: data.result, expiresAt: Date.now() + 4.5 * 60 * 1_000 };
}

// ── resolveToken (with cache) ─────────────────────────────────────────────────

/**
 * Resolve a valid ApiPostal bearer token for the given businessId.
 * Returns null when the business has no OCA credential row (graceful degradation).
 * Deduplicates concurrent cold-start fetches via the inflight promise.
 */
export async function resolveToken(businessId: string): Promise<OcaAuthContext | null> {
  const creds = await getCourierCredentialPort().loadOca(businessId);
  if (!creds) return null;

  const entry = getCacheEntry(businessId);
  if (entry.token && entry.token.expiresAt - Date.now() > TOKEN_REFRESH_BUFFER_MS) {
    return entry.token;
  }
  if (entry.inflight) return entry.inflight;

  entry.inflight = loginSigma(creds.usuario, creds.password)
    .then((ctx) => { entry.token = ctx; entry.inflight = null; return ctx; })
    .catch((err) => { entry.inflight = null; throw err; });
  return entry.inflight;
}

// ── Generic authed fetch (ApiPostal) ─────────────────────────────────────────

async function apiPostalFetch(
  path: string,
  init: RequestInit,
  ctx: OcaAuthContext,
): Promise<Response> {
  const url = `${APIPOSTAL_BASE}${path}`;
  const headers: Record<string, string> = {
    Authorization: `bearer ${ctx.accessToken}`,
    "Content-Type": "application/json",
    Accept:         "application/json",
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

// ── ObtenerSucursalOca ────────────────────────────────────────────────────────

/**
 * Fetch OCA branches for a postal code.
 * ObtenerSucursalOca is unrestricted per docs but we pass the bearer token anyway.
 */
export async function obtenerSucursales(
  codigoPostal: string,
  ctx: OcaAuthContext,
): Promise<OcaSucursal[]> {
  return withOcaCircuit("oca.sucursales", async () => {
    const url =
      `${APIPOSTAL_BASE}/OCAGEOApiController/ObtenerSucursalOca` +
      `?codigoPostal=${encodeURIComponent(codigoPostal)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(url, {
        method: "GET",
        headers: { Authorization: `bearer ${ctx.accessToken}`, Accept: "application/json" },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      cloudLog({
        severity: "WARNING", component: "A2A", action: "OCA_SUCURSALES_ERROR",
        a2a_transfer: false, message: `OCA ObtenerSucursalOca HTTP ${res.status}`,
        data: { codigoPostal, status: res.status },
      });
      return [];
    }
    const data = (await res.json()) as { success?: boolean; result?: OcaSucursal[] };
    return Array.isArray(data.result) ? data.result : [];
  }, []);
}

// ── EstadoActual ──────────────────────────────────────────────────────────────

/**
 * Returns the current status of a shipment by tracking number.
 * POST OCAGEOApiController/EstadoActual
 */
export async function fetchEstadoActual(
  nroEnvio: string,
  ctx: OcaAuthContext,
): Promise<OcaEstadoActualResponse> {
  return withOcaCircuit("oca.tracking.estado", async () => {
    const res = await apiPostalFetch(
      "/OCAGEOApiController/EstadoActual",
      { method: "POST", body: JSON.stringify({ nroEnvio, retrocompatibilidad: false }) },
      ctx,
    );
    if (!res.ok) throw new Error(`OCA EstadoActual HTTP ${res.status}`);
    return (await res.json()) as OcaEstadoActualResponse;
  }, { success: false, result: null } as unknown as OcaEstadoActualResponse);
}

// ── HistorialSeguimiento ──────────────────────────────────────────────────────

/**
 * Returns the full tracking history of a shipment.
 * POST OCAGEOApiController/HistorialSeguimiento
 */
export async function fetchHistorialSeguimiento(
  nroEnvio: string,
  ctx: OcaAuthContext,
): Promise<OcaHistorialResponse> {
  return withOcaCircuit("oca.tracking.historial", async () => {
    const res = await apiPostalFetch(
      "/OCAGEOApiController/HistorialSeguimiento",
      { method: "POST", body: JSON.stringify({ nroEnvio, retrocompatibilidad: false }) },
      ctx,
    );
    if (!res.ok) throw new Error(`OCA HistorialSeguimiento HTTP ${res.status}`);
    return (await res.json()) as OcaHistorialResponse;
  }, { success: false, result: null } as unknown as OcaHistorialResponse);
}
