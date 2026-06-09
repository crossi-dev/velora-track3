// MercadoPago API helpers — extracted from handle-payments-rpc.ts.
// Pure HTTP helpers with no ADK/RPC concerns.

import { cloudLog } from "@/lib/cloud-logger";
import { prisma } from "@/lib/prisma";
import { decrypt } from "@velora/core-utils/mp-token-cipher";
import { getMpConfig } from "@/app/api/integrations/mp/_lib/config";
import { getValidAccessToken } from "@/app/api/integrations/mp/_lib/refresh-token";
import { MercadoPagoConfig, Preference } from "mercadopago";
import {
  buildMpItems,
  type MpPreferenceItem,
  type MpPreferenceShipping,
} from "./mp-preference-sale-items";
import { mpSdkWithRetry } from "./mp-fetch-retry";

// MP_API_BASE: canonical MP API root — used by mp-status-helpers.ts for logging context.
export const MP_API_BASE = "https://api.mercadopago.com";
export const MP_HTTP_TIMEOUT_MS = 10_000;

// Sentinel value returned when a business has no MpConnection row.
// Distinct from null (general failure) so callers can surface a user-facing message.
export const MP_TOKEN_NOT_CONNECTED = "MP_TOKEN_NOT_CONNECTED" as const;

// Sentinel returned when the stored token is past its expiresAt timestamp.
export const MP_TOKEN_EXPIRED = "MP_TOKEN_EXPIRED" as const;

// Sentinel returned when AES-GCM decryption fails (corrupt ciphertext or wrong key).
export const MP_TOKEN_DECRYPT_ERROR = "MP_TOKEN_DECRYPT_ERROR" as const;

// Sentinel returned when the business has a valid MpConnection but has not
// configured (or provisioned) their MP POS yet. QR in-store cannot proceed
// without externalPosId — the owner must set it in Settings or via the
// automated POS provisioning flow (WS1-B seam, pending MP API decision).
export const MP_POS_NOT_CONFIGURED = "MP_POS_NOT_CONFIGURED" as const;

// Resolves the MP access token for a business from its MpConnection row (per-business
// OAuth credentials). This is the Checkout Pro payment-link path.
//
// Resolution order:
//   1. Valid token → return plaintext.
//   2. Expired + MP_CLIENT_ID/SECRET configured → attempt silent refresh via getValidAccessToken.
//      On success: return fresh token. On revocation (row deleted): return MP_TOKEN_NOT_CONNECTED.
//      On non-revocation failure: fall through to MP_TOKEN_EXPIRED.
//   3. Expired + no client credentials → return MP_TOKEN_EXPIRED.
//   4. No MpConnection row → return MP_TOKEN_NOT_CONNECTED.
//   5. Unexpected DB/decryption error → return null.
//
// `prefetchedConnection` — when the caller already loaded the MpConnection row
// (e.g. from BizSnapshot.mpConnectionRaw in handle-payments-rpc.ts) pass it here
// to skip the redundant mpConnection.findUnique DB call.
export async function getMpTokenForBusiness(
  businessId: string | null,
  prefetchedConnection?: { accessTokenCiphertext: string | null; expiresAt: Date; scope: string | null } | null,
): Promise<string | typeof MP_TOKEN_NOT_CONNECTED | typeof MP_TOKEN_EXPIRED | typeof MP_TOKEN_DECRYPT_ERROR | null> {
  if (!businessId) return null;

  try {
    const connection = prefetchedConnection !== undefined
      ? prefetchedConnection
      : await prisma.mpConnection.findUnique({
          where: { businessId },
          select: { accessTokenCiphertext: true, expiresAt: true, scope: true },
        });

    if (!connection) {
      // Business has never connected their MP account.
      return MP_TOKEN_NOT_CONNECTED;
    }

    // For self-managed tokens there is no refresh flow — the owner pastes a
    // fresh one via /api/integrations/mp/connect-token when it expires.
    // Skip the OAuth refresh path entirely; just check expiry and return.
    if (connection.expiresAt < new Date()) {
      if (connection.scope !== "self-managed") {
        // V-1: OAuth-connected token — attempt silent refresh via refresh-token cycle
        // when MP_CLIENT_ID/SECRET are configured.
        const cfg = getMpConfig();
        if (cfg.isConfigured) {
          cloudLog({
            severity: "INFO",
            component: "A2A",
            action: "MP_TOKEN_AUTO_REFRESH_ATTEMPT",
            a2a_transfer: false,
            message: "getMpTokenForBusiness: token expirado — intentando auto-refresh",
            data: { businessId, expiresAt: connection.expiresAt.toISOString() },
          });
          const refreshed = await getValidAccessToken(businessId);
          if (refreshed) return refreshed;
          // null: refresh failed or token was revoked (row deleted).
          // Re-check: if the row is gone, surface NOT_CONNECTED so owner sees reconnect.
          const still = await prisma.mpConnection.findUnique({ where: { businessId }, select: { id: true } });
          if (!still) return MP_TOKEN_NOT_CONNECTED;
        } else {
          cloudLog({
            severity: "WARNING",
            component: "A2A",
            action: "MP_TOKEN_EXPIRED",
            a2a_transfer: false,
            message: "getMpTokenForBusiness: token expirado — requiere reconexión OAuth (refresh no configurado)",
            data: { businessId, expiresAt: connection.expiresAt.toISOString() },
          });
        }
      } else {
        // Self-managed: token expired. Owner must paste a new one.
        cloudLog({
          severity: "WARNING",
          component: "A2A",
          action: "MP_TOKEN_EXPIRED",
          a2a_transfer: false,
          message: "getMpTokenForBusiness: self-managed token expirado — dueño debe pegar uno nuevo",
          data: { businessId, expiresAt: connection.expiresAt.toISOString() },
        });
      }
      return MP_TOKEN_EXPIRED;
    }

    // Prefer AES-256-GCM ciphertext; fall back to legacy plaintext column for
    // rows created before the encryption migration (pre-commit 8a50e655).
    if (connection.accessTokenCiphertext) {
      // Fix (HIGH): catch decrypt() throws (corrupt ciphertext / wrong key) and
      // return a distinct sentinel instead of the opaque null from the outer catch.
      try {
        return decrypt(connection.accessTokenCiphertext);
      } catch (decryptErr) {
        cloudLog({
          severity: "WARNING",
          component: "A2A",
          action: "MP_TOKEN_DECRYPT_ERROR",
          a2a_transfer: false,
          message: "getMpTokenForBusiness: decrypt() falló — ciphertext corrupto o clave incorrecta",
          data: { businessId, error: decryptErr instanceof Error ? decryptErr.message : String(decryptErr) },
        });
        return MP_TOKEN_DECRYPT_ERROR;
      }
    }

    // No ciphertext — connection row has no token. This should not happen after
    // migration 20260519350000 dropped the plaintext columns.
    cloudLog({
      severity: "ERROR",
      component: "A2A",
      action: "MP_TOKEN_MISSING_CIPHERTEXT",
      a2a_transfer: false,
      message: "MpConnection accessTokenCiphertext is null — token unavailable. Row may be corrupt.",
      data: { businessId },
    });
    return MP_TOKEN_DECRYPT_ERROR;
  } catch (err) {
    cloudLog({
      severity: "ERROR",
      component: "A2A",
      action: "MP_TOKEN_RESOLUTION_ERROR",
      a2a_transfer: false,
      message: "getMpTokenForBusiness: error resolviendo token",
      data: { businessId, error: err instanceof Error ? err.message : String(err) },
    });
    return null;
  }
}

// Proactive MP reconnection nudge moved to ./mp-reconnect-nudge.ts to keep
// this file under the 300-line area cap. Re-exported for backward-compat.
export { nudgeMpReconnect } from "./mp-reconnect-nudge";

// Re-export types so callers can import from a single entry point.
export type { MpPreferenceItem, MpPreferenceShipping };

export async function createMpPreference(params: {
  accessToken: string;
  amountARS: number;
  description: string;
  customerName?: string;
  businessId: string;
  // Fix (MEDIUM): renamed from paymentIntentId — this carries the composite
  // "{businessId}:{paymentIntentId}" value, not a bare paymentIntentId.
  externalReference: string;
  // Optional breakdown. When provided the preference shows individual lines
  // instead of a single global item. Requires sum(items × qty) + shipping = amountARS.
  items?: MpPreferenceItem[];
  shipping?: MpPreferenceShipping;
  /** Prefetched business name — avoids a business.findUnique DB call inside this function. */
  prefetchedBusinessName?: string | null;
  /**
   * Optional link lifetime in days. When present, sets the MP preference
   * `date_of_expiration` to now + N days — "ISO 8601 expiration date after which
   * the preference cannot be paid" (mercadopago SDK PreferenceRequest type).
   * Used for remote payment links (3-day default upstream); omitted for the
   * in-person QR path so that flow is byte-for-byte unchanged.
   * NOTE: PaymentIntent.expiresAt in the DB stays at now+60min (LINK_EXPIRY_MS).
   * The reconcile cron queries `estado`, not `expiresAt`, so the 3-day MP
   * preference lives independently. Asymmetry is intentional and safe — verified 2026-06-07.
   */
  expiresInDays?: number;
}): Promise<{ preferenceId: string; checkoutUrl: string } | { error: string; detail: unknown }> {
  const appUrl = (process.env.VELORA_APP_URL ?? "").trim();
  let businessName: string;
  if (params.prefetchedBusinessName != null) {
    businessName = params.prefetchedBusinessName || "Velora";
  } else {
    const business = await prisma.business.findUnique({
      where: { id: params.businessId },
      select: { name: true },
    });
    businessName = business?.name ?? "Velora";
  }

  // Fix (MEDIUM): append ?businessId= so the webhook can parse the selling
  // business from the query param as a belt-and-suspenders cross-check.
  const notificationUrl = appUrl
    ? `${appUrl}/api/integrations/mp/webhook?businessId=${encodeURIComponent(params.businessId)}`
    : undefined;

  // Build items array via pure helper. Validates sum when breakdown is provided;
  // falls back to single global item when no breakdown is available (backward compat).
  const mpItems = buildMpItems({
    items: params.items,
    shipping: params.shipping,
    amountARS: params.amountARS,
    description: params.description,
  });

  // SDK Items type requires `id` (integrator-assigned). MP API accepts any string;
  // we derive it from the item title as a stable, unique-enough value per preference.
  const sdkItems = mpItems.map((it, idx) => ({
    ...it,
    id: `item-${idx}`, // MP API optional in practice; SDK TS type requires it
  }));

  const body = {
    items: sdkItems,
    back_urls: {
      success: appUrl ? `${appUrl}/cobro/success` : undefined,
      failure: appUrl ? `${appUrl}/cobro/failure` : undefined,
      pending: appUrl ? `${appUrl}/cobro/pending` : undefined,
    },
    auto_return: "approved",
    ...(notificationUrl ? { notification_url: notificationUrl } : {}),
    ...(typeof params.expiresInDays === "number"
      ? { date_of_expiration: new Date(Date.now() + params.expiresInDays * 86_400_000).toISOString() }
      : {}),
    external_reference: params.externalReference,
    statement_descriptor: businessName.slice(0, 22), // MP max 22 chars
  };

  // Official SDK (mercadopago v3): configured per-request with the resolved
  // access token. Token resolution/encryption is unchanged — only the HTTP
  // transport is replaced with the SDK.
  //
  // The SDK's retryWithExponentialBackoff only retries HTTP 5xx (not 429).
  // mpSdkWithRetry wraps the SDK call to restore 429 resilience with the same
  // constants as the old mpFetchWithRetry: 3 attempts, [1s, 2s] backoff,
  // full jitter, 30 s overall deadline.
  const mpClient = new MercadoPagoConfig({ accessToken: params.accessToken });
  const preference = new Preference(mpClient);
  // retries: 1 disables SDK-internal retry (attempt >= retries on first failure).
  // mpSdkWithRetry is the sole retry authority — prevents 5xx amplification (up to
  // 3 outer × 2 SDK internal = 6-9 calls with default retries: 2).
  const reqOpts = { timeout: MP_HTTP_TIMEOUT_MS, retries: 1 };

  try {
    const sdkRes = await mpSdkWithRetry(
      () => preference.create({ body, requestOptions: reqOpts }),
      "preference.create",
    );

    // SDK success: parsed JSON body with api_response appended.
    const preferenceId = typeof sdkRes.id === "string" ? sdkRes.id : null;
    const checkoutUrl = typeof sdkRes.init_point === "string" ? sdkRes.init_point : null;
    if (!preferenceId || !checkoutUrl) {
      return { error: "bad_shape", detail: { body: sdkRes } };
    }
    return { preferenceId, checkoutUrl };
  } catch (err) {
    // SDK throws the parsed error JSON on non-2xx (RestClient: throw await response.json()).
    const detail = err && typeof err === "object" ? err : { raw: String(err) };
    const httpStatus = err && typeof err === "object"
      ? (err as Record<string, unknown>).status
      : undefined;
    cloudLog({
      severity: "ERROR",
      component: "A2A",
      action: "MP_PREFERENCE_CREATE_FAILED",
      a2a_transfer: false,
      message: "MP preference create failed (SDK)",
      data: { httpStatus, detail },
    });
    return { error: "mp_api_error", detail };
  }
}

// getMpPaymentStatusByPreference moved to ./mp-status-helpers.ts to keep this
// file under the 300-line limit. Re-exported here for backward compatibility.
export { getMpPaymentStatusByPreference } from "./mp-status-helpers";
