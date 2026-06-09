// MODO API helpers — real HTTP client for the MODO merchant payment API.
//
// ┌─────────────────────────────────────────────────────────────────────────┐
// │ CRITICAL — API IS REVERSE-ENGINEERED, NO OFFICIAL DOCS AVAILABLE        │
// │                                                                         │
// │ All endpoint shapes, auth flow, and payload structures below were        │
// │ extracted from the open-source WooCommerce plugin "Paga con MODO"       │
// │ (ingenieriamodo, v1.1.0, SVN revision 3538056). MODO does not publish   │
// │ a merchant API specification for direct integrations.                   │
// │                                                                         │
// │ BLOCKED-EXTERNAL: contact desarrolladores@modo.com.ar to:               │
// │   1. Obtain official API documentation and sandbox credentials.         │
// │   2. Confirm endpoint paths, auth scheme, and webhook signature method. │
// │   3. Validate that the base URL (merchants.playdigital.com.ar) remains  │
// │      stable — PlayDigital is MODO's tech partner but this is unconfirmed│
// │      as of 2026.                                                        │
// │   4. Confirm the consumer checkout URL pattern (see modo-intention-     │
// │      helpers.ts — MODO_CHECKOUT_URL_CONSTRUCTED warning).               │
// │ Status as of 2026-05-23: MODO contact still pending response.           │
// │                                                                         │
// │ Until official specs are obtained, treat this entire module as          │
// │ provisional. Any MODO infrastructure update may break these calls.      │
// └─────────────────────────────────────────────────────────────────────────┘
//
// API discovery source: WooCommerce plugin "Paga con MODO" (open source, ingenieriamodo,
// v1.1.0, SVN revision 3538056). Endpoint shapes extracted from:
//   /trunk/Sdk/MODOSdk.php     — auth + payment creation + status + webhook registration
//   /trunk/Api/MODOApi.php     — base URL
//   /trunk/Orders/Webhooks.php — webhook payload shape
//
// Base URL: https://merchants.playdigital.com.ar/merchants
//
// Auth:   POST /middleman/token
//   body: { username: clientId, password: clientSecret }
//   → JWT (three-part dot-separated). Cache by {clientId} with exp extracted from JWT payload.
//   Authorization header on subsequent calls: Bearer <token>
//
// Create: POST /ecommerce/payment-intention  (see modo-intention-helpers.ts)
// Status: GET  /ecommerce/payment-intention/{intentionId}  (see modo-intention-helpers.ts)
//
// Webhook: POST /api/integrations/modo/webhook (Velora side)
//   MODO calls a URL we register via PATCH /middleman/ with { callbackUrl }
//   Payload: { id, external_intention_id, status: "ACCEPTED"|"REJECTED"|"CANCELLED" }
//
// GAPS (MODO docs are SDK-focused; these are best-approximations):
//   - The token endpoint path "/middleman/token" is derived from the WP plugin SDK.
//     If MODO updates their infrastructure, this path may change.
//   - "terminalId" is hardcoded as "1" in the WP plugin; we do the same.
//   - No HMAC webhook signature documented — we skip signature verification (noted inline).
//   - The base URL "merchants.playdigital.com.ar" is derived from the open-source plugin.
//     PlayDigital is MODO's technology partner.

import { cloudLog } from "@/lib/cloud-logger";
import { prisma } from "@/lib/prisma";
import { decrypt } from "@/infrastructure/crypto/mp-token-cipher";

// ── Constants ────────────────────────────────────────────────────────────────

export const MODO_API_BASE = "https://merchants.playdigital.com.ar/merchants";
export const MODO_HTTP_TIMEOUT_MS = 10_000;
export const MODO_TERMINAL_ID = "1"; // WP plugin hardcodes "123"; "1" is more neutral for prod

// ── Credential type ───────────────────────────────────────────────────────────

export interface ModoCredentials {
  clientId: string;
  clientSecret: string;
  storeId: string;
}

// ── Sentinel values ───────────────────────────────────────────────────────────

/** Business has no ModoConnection row (never connected). */
export const MODO_TOKEN_NOT_CONNECTED = "MODO_TOKEN_NOT_CONNECTED" as const;

/** Credentials decryption failed (corrupt ciphertext or wrong key). */
export const MODO_TOKEN_DECRYPT_ERROR = "MODO_TOKEN_DECRYPT_ERROR" as const;

/** Network error or timeout when calling MODO token endpoint. */
export const MODO_TOKEN_NETWORK_ERROR = "MODO_TOKEN_NETWORK_ERROR" as const;

// ── Token cache ───────────────────────────────────────────────────────────────
// Per-business (keyed on businessId) in-memory cache with JWT expiry.
// Safe for single-instance Cloud Run. Multi-instance deploys re-auth on cache miss —
// extra auth calls are cheap; wrong token is not.

interface CachedToken {
  token: string;
  expiresAtMs: number;
}

const tokenCache = new Map<string, CachedToken>();
const TOKEN_EXPIRY_MARGIN_MS = 60_000; // re-auth 1 min before real expiry

function extractJwtExp(jwt: string): number | null {
  try {
    const parts = jwt.split(".");
    if (parts.length !== 3) return null;
    // JWT payload is base64url-encoded JSON
    const payloadJson = Buffer.from(parts[1], "base64url").toString("utf8");
    const payload = JSON.parse(payloadJson) as { exp?: number };
    return typeof payload.exp === "number" ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

// ── Credential loader ─────────────────────────────────────────────────────────

/**
 * Loads and decrypts the MODO credentials for a business.
 * Returns null if not connected or decrypt fails.
 */
export async function loadModoCredentials(
  businessId: string,
): Promise<ModoCredentials | typeof MODO_TOKEN_NOT_CONNECTED | typeof MODO_TOKEN_DECRYPT_ERROR> {
  try {
    const row = await prisma.modoConnection.findUnique({
      where: { businessId },
      select: { encryptedCredentials: true },
    });
    if (!row) return MODO_TOKEN_NOT_CONNECTED;

    let json: string;
    try {
      json = decrypt(row.encryptedCredentials);
    } catch (decryptErr) {
      cloudLog({
        severity: "WARNING",
        component: "A2A",
        action: "MODO_CREDS_DECRYPT_ERROR",
        a2a_transfer: false,
        message: "loadModoCredentials: decrypt() falló — ciphertext corrupto o clave incorrecta",
        data: {
          businessId,
          error: decryptErr instanceof Error ? decryptErr.message : String(decryptErr),
        },
      });
      return MODO_TOKEN_DECRYPT_ERROR;
    }

    const creds = JSON.parse(json) as Record<string, unknown>;
    const clientId = typeof creds.clientId === "string" ? creds.clientId : null;
    const clientSecret = typeof creds.clientSecret === "string" ? creds.clientSecret : null;
    const storeId = typeof creds.storeId === "string" ? creds.storeId : null;

    if (!clientId || !clientSecret || !storeId) {
      cloudLog({
        severity: "WARNING",
        component: "A2A",
        action: "MODO_CREDS_INCOMPLETE",
        a2a_transfer: false,
        message: "loadModoCredentials: credenciales almacenadas incompletas (faltan campos obligatorios)",
        data: { businessId, hasClientId: !!clientId, hasClientSecret: !!clientSecret, hasStoreId: !!storeId },
      });
      return MODO_TOKEN_NOT_CONNECTED;
    }

    return { clientId, clientSecret, storeId };
  } catch (err) {
    cloudLog({
      severity: "ERROR",
      component: "A2A",
      action: "MODO_CREDS_LOAD_ERROR",
      a2a_transfer: false,
      message: "loadModoCredentials: error DB cargando credenciales",
      data: { businessId, error: err instanceof Error ? err.message : String(err) },
    });
    return MODO_TOKEN_NOT_CONNECTED;
  }
}

// ── Auth: obtain Bearer token ─────────────────────────────────────────────────

/**
 * Returns a valid Bearer token for the given credentials.
 * Caches by businessId; re-auths before the JWT expires.
 * NEVER includes the password in any log line.
 */
export async function getModoToken(
  businessId: string,
  creds: ModoCredentials,
  fetchImpl: typeof fetch = fetch,
): Promise<string | typeof MODO_TOKEN_NETWORK_ERROR | null> {
  const cached = tokenCache.get(businessId);
  const now = Date.now();
  if (cached && cached.expiresAtMs - now > TOKEN_EXPIRY_MARGIN_MS) {
    return cached.token;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MODO_HTTP_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${MODO_API_BASE}/middleman/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // clientId=username, clientSecret=password — per WP plugin source
      body: JSON.stringify({ username: creds.clientId, password: creds.clientSecret }),
      signal: controller.signal,
    });
    const text = await res.text();
    let parsed: unknown = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }

    if (!res.ok) {
      cloudLog({
        severity: "WARNING",
        component: "A2A",
        action: "MODO_AUTH_FAILED",
        a2a_transfer: false,
        message: `MODO /middleman/token failed status=${res.status}`,
        // clientId is safe to log; password/secret is NEVER logged
        data: { businessId, status: res.status, clientId: creds.clientId },
      });
      return null;
    }

    // The token is a bare JWT string, or wrapped in { token: "..." }.
    // WP plugin reads it directly from response body as a string.
    // A bare JWT is three base64url segments joined by "." — it is not valid JSON,
    // so JSON.parse returns null for it. We fall back to the raw text in that case.
    const token =
      typeof parsed === "string"
        ? parsed
        : (typeof (parsed as Record<string, unknown>)?.token === "string"
          ? (parsed as Record<string, unknown>).token as string
          // Last resort: raw text might be a bare JWT (non-JSON)
          : (text.trim().split(".").length === 3 ? text.trim() : null));

    if (!token) {
      cloudLog({
        severity: "WARNING",
        component: "A2A",
        action: "MODO_AUTH_BAD_SHAPE",
        a2a_transfer: false,
        message: "MODO /middleman/token: respuesta sin token parseable",
        data: { businessId },
      });
      return null;
    }

    const expMs = extractJwtExp(token) ?? now + 60 * 60 * 1000; // fallback: 1h
    tokenCache.set(businessId, { token, expiresAtMs: expMs });

    cloudLog({
      severity: "INFO",
      component: "A2A",
      action: "MODO_AUTH_OK",
      a2a_transfer: false,
      message: "MODO token obtenido correctamente",
      data: { businessId, expiresAt: new Date(expMs).toISOString() },
    });
    return token;
  } catch (err) {
    cloudLog({
      severity: "ERROR",
      component: "A2A",
      action: "MODO_AUTH_ERROR",
      a2a_transfer: false,
      message: "MODO /middleman/token: error de red o timeout",
      data: { businessId, error: err instanceof Error ? err.message : String(err) },
    });
    return MODO_TOKEN_NETWORK_ERROR;
  } finally {
    clearTimeout(timeout);
  }
}

// ── Re-exports from sibling (intention creation + status) ────────────────────
// Consumers and tests import from this single entry point; impl lives in
// modo-intention-helpers.ts to stay under the 300-line file limit.

export {
  createModoIntention,
  getModoIntentionStatus,
} from "./modo-intention-helpers";

export type {
  ModoCreateIntentionParams,
  ModoIntentionCreated,
  ModoIntentionStatus,
  ModoIntentionStatusResult,
} from "./modo-intention-helpers";
