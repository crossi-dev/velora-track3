// src/lib/mcp/_lib/tiendanube-ventas.client.ts — Tiendanube HTTP client + credentials layer.
//
// Handles credential loading, shared auth/URL helpers, generic HTTP requests,
// and paginated product fetching for the Tiendanube REST API.
//
// Raw API shapes live in tiendanube-api-types.ts (split to stay within 300-line limit).
// Re-exported here so existing consumers (tiendanube-ventas.adapter.ts and tests)
// keep a single import point.
//
// API facts confirmed against https://tiendanube.github.io/api-documentation (2026-06-08):
//
//   BASE URL:    https://api.tiendanube.com/2025-03/{store_id}/...
//   AUTH HEADER: Authorization: Bearer {access_token}
//                (capital-B Bearer; "Authorization" not "Authentication" — BUG FIXED 2026-06-08)
//   USER-AGENT:  Velora (hola@somosvelora.com)  (required per Tiendanube API terms)
//
// Multi-tenant auth:
//   Access token is loaded from a per-business BusinessChannelCredential row
//   (provider="tiendanube") — NOT a global env var.
//   Pattern mirrors messaging-credential-loader.ts (loadPedidosYaCredentials).
//
//   TODO (production): Insert a credential row per tenant:
//     { businessId, provider: "tiendanube",
//       encryptedCredentials: encryptCredential(JSON.stringify({ accessToken, storeId })) }

import { prisma } from "@/lib/prisma";
import { decryptCredential } from "@/lib/credential-cipher";
export type {
  TiendanubeLocalizedString,
  TiendanubeVariant,
  TiendanubeProduct,
  TiendanubeCustomer,
  TiendanubeOrderLineItem,
  TiendanubeOrder,
  TiendanubeBulkStockPriceEntry,
} from "./tiendanube-api-types";
import type { TiendanubeProduct } from "./tiendanube-api-types";

// ── Tiendanube API constants ──────────────────────────────────────────────────

/** Products per page (Tiendanube max is 200; 200 maximizes page efficiency). */
const TN_PER_PAGE = 200;

/** Safety cap: never fetch more than this many pages (avoids runaway loops on very large stores). */
const TN_MAX_PAGES = 10;

/**
 * Tiendanube API version prefix.
 * Source: https://tiendanube.github.io/api-documentation/getting-started/introduction
 * (HTTP 200 verified 2026-06-08): "https://api.tiendanube.com/2025-03/{store_id}/..."
 */
const TN_API_VERSION = "2025-03";

/** User-Agent required by Tiendanube API terms — must identify the integration. */
const TN_USER_AGENT = "Velora (hola@somosvelora.com)";

// ── URL builder ───────────────────────────────────────────────────────────────

/**
 * Builds the Tiendanube base URL for a given store and resource path.
 * Single source of truth for URL construction across all TN adapters.
 * Example: tiendanubeBaseUrl("99999", "products") →
 *   https://api.tiendanube.com/2025-03/99999/products
 */
export function tiendanubeBaseUrl(storeId: string, resource: string): string {
  return `https://api.tiendanube.com/${TN_API_VERSION}/${storeId}/${resource}`;
}

// ── Auth header builder ───────────────────────────────────────────────────────

/**
 * Returns the standard Tiendanube auth headers.
 * BUG FIXED 2026-06-08: previous code used "Authentication: bearer {token}".
 *   Correct per docs: "Authorization: Bearer {token}" (header name + capitalisation).
 * Source: https://tiendanube.github.io/api-documentation/getting-started/authentication
 */
export function tiendanubeAuthHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    "User-Agent": TN_USER_AGENT,
    "Content-Type": "application/json",
  };
}

// ── Credential shape ──────────────────────────────────────────────────────────

export interface TiendanubeCredentials {
  /** Tiendanube OAuth access token. NEVER log. */
  accessToken: string;
  /** Numeric store ID (from Tiendanube OAuth grant). Used in the base URL path. */
  storeId: string;
}

// ── Credential loader ─────────────────────────────────────────────────────────

/**
 * Loads and decrypts per-business Tiendanube credentials from BusinessChannelCredential.
 * Returns null when no credential row exists — caller fails-closed with a clear error.
 *
 * Security: decrypted values must NOT be logged or returned to clients.
 */
export async function loadTiendanubeCredentials(
  businessId: string,
): Promise<TiendanubeCredentials | null> {
  const row = await prisma.businessChannelCredential.findUnique({
    where: { businessId_provider: { businessId, provider: "tiendanube" } },
    select: { encryptedCredentials: true },
  });

  if (!row) return null;

  // decryptCredential throws on GCM auth tag mismatch (tampered ciphertext).
  const plaintext = decryptCredential(row.encryptedCredentials);
  const parsed = JSON.parse(plaintext) as Record<string, unknown>;

  const accessToken = typeof parsed.accessToken === "string" ? parsed.accessToken.trim() : "";
  const storeId = typeof parsed.storeId === "string" ? parsed.storeId.trim() : "";

  // Both fields required — incomplete row treated as absent.
  if (!accessToken || !storeId) return null;

  // NEVER log decrypted values.
  return { accessToken, storeId };
}

// ── Generic HTTP request helper ───────────────────────────────────────────────

/**
 * Makes a single authenticated Tiendanube API request.
 *
 * Error handling:
 *   401/403 → TIENDANUBE_AUTH_ERROR (bad or expired token)
 *   422     → TIENDANUBE_422 with TN validation detail; sets .status = 422 on the error
 *   429     → TIENDANUBE_RATE_LIMIT with reset timestamp from x-rate-limit-reset header
 *   other   → TIENDANUBE_API_ERROR
 *   DELETE  → returns {} (TN DELETE responds 200 with empty body)
 */
export async function tiendanubeRequest<T>(
  url: string,
  token: string,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" = "GET",
  body?: unknown,
): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: tiendanubeAuthHeaders(token),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  if (response.status === 401 || response.status === 403) {
    throw new Error(
      `TIENDANUBE_AUTH_ERROR: ${response.status} — check access token validity and permissions.`,
    );
  }

  if (response.status === 422) {
    let detail = response.statusText;
    try {
      const errBody = (await response.json()) as Record<string, unknown>;
      detail = typeof errBody.description === "string"
        ? errBody.description
        : JSON.stringify(errBody);
    } catch { /* ignore parse errors on the error response body */ }
    const err = new Error(`TIENDANUBE_422: ${detail}`);
    (err as Error & { status: number }).status = 422;
    throw err;
  }

  if (response.status === 429) {
    const retryAfter = response.headers.get("x-rate-limit-reset") ?? "unknown";
    throw new Error(
      `TIENDANUBE_RATE_LIMIT: Too many requests. Rate limit resets at: ${retryAfter}. ` +
        "TN rate: 2 req/s burst 40. Reduce call frequency or implement backoff.",
    );
  }

  if (!response.ok) {
    throw new Error(
      `TIENDANUBE_API_ERROR: ${response.status} ${response.statusText} — ${url}`,
    );
  }

  // DELETE on Tiendanube returns 200 with empty body; guard before JSON parse.
  if (method === "DELETE") {
    return {} as T;
  }

  return response.json() as Promise<T>;
}

// ── Paginated product fetcher ─────────────────────────────────────────────────

/**
 * Fetches all products from the Tiendanube API with pagination.
 * Stops when the last page returns fewer results than per_page.
 * Capped at TN_MAX_PAGES to prevent runaway loops — logs a warning when capped.
 *
 * Consumed by tiendanube-ventas.adapter.ts (queryCatalog).
 */
export async function fetchAllTiendanubeProducts(
  credentials: TiendanubeCredentials,
): Promise<TiendanubeProduct[]> {
  const baseUrl = tiendanubeBaseUrl(credentials.storeId, "products");

  const all: TiendanubeProduct[] = [];
  let page = 1;
  let capped = false;

  while (true) {
    const url = `${baseUrl}?page=${page}&per_page=${TN_PER_PAGE}`;
    const batch = await tiendanubeRequest<TiendanubeProduct[]>(url, credentials.accessToken);

    all.push(...batch);

    if (batch.length < TN_PER_PAGE) break;

    if (page >= TN_MAX_PAGES) {
      capped = true;
      break;
    }

    page++;
  }

  if (capped) {
    console.warn(
      `[TiendanubeVentasAdapter] Catalog fetch capped at ${TN_MAX_PAGES} pages ` +
        `(${all.length} products loaded). Store may have more products.`,
    );
  }

  return all;
}
