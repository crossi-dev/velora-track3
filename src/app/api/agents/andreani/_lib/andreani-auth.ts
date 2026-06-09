// Andreani auth — credential resolution + per-business token cache.
//
// Auth flow: POST /login with CLIENT_ID + CLIENT_SECRET → access_token (1h TTL).
//
// Per-business credential resolution (bring-your-own-account):
//   1. Attempt to load CourierCredential for (businessId, "andreani") from DB.
//   2. If found + decryptable → use those credentials.
//   3. If absent → fall back to platform-wide env vars (ANDREANI_CLIENT_ID /
//      ANDREANI_CLIENT_SECRET). A WARNING is cloudLog'd so the fallback is
//      observable in Cloud Logging.
//
// Token caching: per-businessId in module scope (Map). Each Cloud Run instance
// holds its own token independently — safe for horizontal scaling.
// The global env-var path uses cache key "__global__".

import { cloudLog } from "@/lib/cloud-logger";
import { getCourierCredentialPort } from "@/infrastructure/courier/courier-credential.adapter";
import type { AndreaniAuthContext, AndreaniLoginResponse } from "./types";

const HTTP_TIMEOUT_MS = 12_000;
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1_000; // refresh 5 min before expiry

/**
 * Resolve the Andreani base URL.
 * Priority: per-business credential environment > ANDREANI_SANDBOX env var > production.
 * Logs an INFO event when the per-business value overrides the env var to keep
 * multi-tenant routing observable.
 *
 * @param credEnvironment - environment field from the per-business CourierCredential,
 *   or undefined when falling back to global env vars.
 * @param businessId      - used only for the override log; omit on global paths.
 */
function getBaseUrl(
  credEnvironment?: "production" | "sandbox",
  businessId?: string,
): string {
  const envVarSandbox = process.env.ANDREANI_SANDBOX === "true";

  // Per-business credential takes priority when present.
  if (credEnvironment !== undefined) {
    const isSandbox = credEnvironment === "sandbox";
    // Log when the per-business setting diverges from the env var so
    // mismatches are visible in Cloud Logging without being noisy on agreement.
    if (isSandbox !== envVarSandbox) {
      cloudLog({
        severity: "INFO",
        component: "A2A",
        action: "ANDREANI_BUSINESS_ENV_OVERRIDE",
        a2a_transfer: false,
        message:
          `Andreani endpoint override: per-business credential uses "${credEnvironment}" ` +
          `but ANDREANI_SANDBOX="${process.env.ANDREANI_SANDBOX ?? "unset"}" ` +
          `(businessId=${businessId ?? "unknown"})`,
        data: {
          businessId,
          expectedEnv: credEnvironment,
          envVar: process.env.ANDREANI_SANDBOX ?? "unset",
        },
      });
    }
    return isSandbox
      ? "https://apisqa.andreani.com"
      : "https://apis.andreani.com";
  }

  // Global env-var path (no per-business credential).
  // Ref: https://developers-sandbox.andreani.com/
  return envVarSandbox
    ? "https://apisqa.andreani.com"
    : "https://apis.andreani.com";
}

// ── Per-business token cache ─────────────────────────────────────────────────

interface CacheEntry {
  token: AndreaniAuthContext | null;
  inflight: Promise<AndreaniAuthContext> | null;
}

export const _tokenCache = new Map<string, CacheEntry>();

function getCacheEntry(key: string): CacheEntry {
  let entry = _tokenCache.get(key);
  if (!entry) {
    entry = { token: null, inflight: null };
    _tokenCache.set(key, entry);
  }
  return entry;
}

// ── Credential resolution ────────────────────────────────────────────────────

export interface ResolvedCreds {
  clientId: string;
  clientSecret: string;
  cacheKey: string;
  /** Resolved environment for this credential set.  Undefined on the global env-var path. */
  environment?: "production" | "sandbox";
}

/**
 * Resolve Andreani credentials for a request.
 * Priority: per-business DB credential → global env vars (fallback).
 */
export async function resolveCredentials(businessId: string): Promise<ResolvedCreds> {
  const perBusiness = await getCourierCredentialPort().loadAndreani(businessId);
  if (perBusiness) {
    return {
      clientId:     perBusiness.clientId,
      clientSecret: perBusiness.clientSecret,
      cacheKey:     businessId,
      environment:  perBusiness.environment,
    };
  }

  const clientId     = process.env.ANDREANI_CLIENT_ID     ?? "";
  const clientSecret = process.env.ANDREANI_CLIENT_SECRET ?? "";

  if (!clientId || !clientSecret) {
    throw new Error(
      "ANDREANI_CLIENT_ID / ANDREANI_CLIENT_SECRET not configured and no per-business " +
      `credential exists for businessId=${businessId}. ` +
      "Connect your Andreani account in Settings → Logística, or set the platform env vars.",
    );
  }

  cloudLog({
    severity: "WARNING",
    component: "A2A",
    action: "ANDREANI_GLOBAL_CREDS_FALLBACK",
    a2a_transfer: false,
    message:
      `businessId=${businessId} has no per-business Andreani credential — using platform env vars. ` +
      "Connect the business's own Andreani account via Settings → Logística to remove this fallback.",
    data: { businessId },
  });

  return { clientId, clientSecret, cacheKey: "__global__" };
}

// ── Token fetch + cache ──────────────────────────────────────────────────────

async function fetchTokenWithCreds(creds: ResolvedCreds): Promise<AndreaniAuthContext> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);

  // creds.cacheKey is "__global__" on the env-var path (no per-business credential),
  // so pass undefined for businessId in that case to suppress the override log.
  const businessId = creds.cacheKey !== "__global__" ? creds.cacheKey : undefined;

  let res: Response;
  try {
    res = await fetch(`${getBaseUrl(creds.environment, businessId)}/v2/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ usuario: creds.clientId, password: creds.clientSecret }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Andreani login failed HTTP ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = (await res.json()) as AndreaniLoginResponse;
  return {
    accessToken: data.access_token,
    expiresAt:   Date.now() + (data.expires_in ?? 3600) * 1_000,
  };
}

export interface ResolvedTokenWithEnv {
  ctx: AndreaniAuthContext;
  /** Resolved environment for endpoint routing.  Undefined on the global env-var path. */
  environment: "production" | "sandbox" | undefined;
}

/**
 * Resolve a valid bearer token AND the environment for the given businessId.
 * Prefer this over `resolveToken` when the caller needs to route API calls to
 * the correct endpoint (apisqa vs apis.andreani.com) for multi-tenant support.
 */
export async function resolveTokenWithEnv(businessId: string): Promise<ResolvedTokenWithEnv> {
  const creds = await resolveCredentials(businessId);
  const entry = getCacheEntry(creds.cacheKey);

  let ctx: AndreaniAuthContext;

  if (entry.token && entry.token.expiresAt - Date.now() > TOKEN_REFRESH_BUFFER_MS) {
    ctx = entry.token;
  } else if (entry.inflight) {
    ctx = await entry.inflight;
  } else {
    entry.inflight = fetchTokenWithCreds(creds)
      .then((c) => {
        entry.token    = c;
        entry.inflight = null;
        return c;
      })
      .catch((err) => {
        entry.inflight = null;
        throw err;
      });
    ctx = await entry.inflight;
  }

  return { ctx, environment: creds.environment };
}

/**
 * Resolve a valid bearer token for the given businessId.
 * Checks the per-businessId cache; fetches a new token when expired or absent.
 * Deduplicates concurrent cold-start fetches via the inflight promise.
 */
export async function resolveToken(businessId: string): Promise<AndreaniAuthContext> {
  const creds = await resolveCredentials(businessId);
  const entry = getCacheEntry(creds.cacheKey);

  if (entry.token && entry.token.expiresAt - Date.now() > TOKEN_REFRESH_BUFFER_MS) {
    return entry.token;
  }

  if (entry.inflight) return entry.inflight;

  entry.inflight = fetchTokenWithCreds(creds)
    .then((ctx) => {
      entry.token    = ctx;
      entry.inflight = null;
      return ctx;
    })
    .catch((err) => {
      entry.inflight = null;
      throw err;
    });

  return entry.inflight;
}
