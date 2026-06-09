// Token refresh helper para Mercado Pago.
//
// Slice 8 (real QR) llama a `getValidAccessToken(businessId)` antes de
// pegarle a la API de MP. La función:
//   - devuelve null si no hay MpConnection (negocio nunca conectó).
//   - devuelve null si MP_CLIENT_ID/SECRET no están configurados (no
//     podemos refrescar igual).
//   - si el accessToken sigue vigente (>5 min de margen) lo devuelve.
//   - si está vencido o cerca de vencerse, llama al endpoint refresh,
//     persiste los tokens nuevos, y devuelve el accessToken fresco.
//   - si MP rechaza el refresh con 401/invalid_grant, borra la
//     MpConnection (token revocado / refresh expirado) y devuelve null.
//
// Slice 7 NO llama a esta helper desde ninguna route — sólo la deja
// lista para que slice 8 la consuma.

import { prisma } from "@/lib/prisma";
import { encrypt, decrypt } from "@/infrastructure/crypto/mp-token-cipher";
import { cloudLog } from "@/lib/cloud-logger";
import { getMpConfig } from "./config";
import { refreshAccessToken } from "./token-exchange";

// Sentinel returned when decrypt() throws (key rotated or corrupted ciphertext).
// Callers can distinguish this from null (connection not found / no ciphertext).
export const DECRYPT_ERROR_SENTINEL = Symbol("MP_TOKEN_DECRYPT_ERROR");
export type ReadTokenResult = string | null | typeof DECRYPT_ERROR_SENTINEL;

/** Read accessToken from a connection row (ciphertext only — plaintext columns dropped). */
function readAccessToken(conn: {
  businessId?: string;
  accessTokenCiphertext: string | null;
}): ReadTokenResult {
  if (!conn.accessTokenCiphertext) {
    cloudLog({
      severity: "ERROR",
      component: "System",
      action: "MP_TOKEN_MISSING_CIPHERTEXT",
      a2a_transfer: false,
      message: "readAccessToken: accessTokenCiphertext is null — token unavailable",
      businessId: conn.businessId,
    });
    return null;
  }
  try {
    return decrypt(conn.accessTokenCiphertext);
  } catch (err) {
    cloudLog({
      severity: "ERROR",
      component: "System",
      action: "MP_TOKEN_DECRYPT_ERROR",
      a2a_transfer: false,
      message: "readAccessToken: decrypt() threw — key may have rotated or ciphertext is corrupted",
      businessId: conn.businessId,
      data: { error: err instanceof Error ? err.message : String(err) },
    });
    return DECRYPT_ERROR_SENTINEL;
  }
}

/** Read refreshToken from a connection row (ciphertext only — plaintext columns dropped). */
function readRefreshToken(conn: {
  businessId?: string;
  refreshTokenCiphertext: string | null;
}): ReadTokenResult {
  if (!conn.refreshTokenCiphertext) {
    cloudLog({
      severity: "ERROR",
      component: "System",
      action: "MP_TOKEN_MISSING_CIPHERTEXT",
      a2a_transfer: false,
      message: "readRefreshToken: refreshTokenCiphertext is null — token unavailable",
      businessId: conn.businessId,
    });
    return null;
  }
  try {
    return decrypt(conn.refreshTokenCiphertext);
  } catch (err) {
    cloudLog({
      severity: "ERROR",
      component: "System",
      action: "MP_TOKEN_DECRYPT_ERROR",
      a2a_transfer: false,
      message: "readRefreshToken: decrypt() threw — key may have rotated or ciphertext is corrupted",
      businessId: conn.businessId,
      data: { error: err instanceof Error ? err.message : String(err) },
    });
    return DECRYPT_ERROR_SENTINEL;
  }
}

const REFRESH_MARGIN_MS = 5 * 60 * 1000; // 5 min

export interface GetValidAccessTokenOptions {
  fetchImpl?: typeof fetch;
  // Override now() en tests para forzar la rama de refresh sin esperar.
  nowMs?: number;
}

export async function getValidAccessToken(
  businessId: string,
  options: GetValidAccessTokenOptions = {},
): Promise<string | null> {
  const cfg = getMpConfig();
  if (!cfg.isConfigured) return null;

  const connection = await prisma.mpConnection.findUnique({
    where: { businessId },
    select: {
      accessTokenCiphertext: true,
      refreshTokenCiphertext: true,
      publicKey: true,
      liveMode: true,
      scope: true,
      expiresAt: true,
    },
  });
  if (!connection) return null;

  const now = options.nowMs ?? Date.now();
  const expiresAtMs = connection.expiresAt.getTime();
  if (expiresAtMs - now > REFRESH_MARGIN_MS) {
    const token = readAccessToken(connection);
    // Sentinel means decrypt failed — return null so caller treats this as
    // a hard failure (not a missing connection). The ERROR log was already emitted.
    if (token === DECRYPT_ERROR_SENTINEL) return null;
    return token;
  }

  // Self-managed tokens have no refresh token — MP cannot refresh them on our
  // behalf. Return the current access token directly; the owner must re-paste
  // it when it eventually expires (MP notifies via the health-check cron).
  if (connection.scope === "self-managed") {
    const token = readAccessToken(connection);
    if (token === DECRYPT_ERROR_SENTINEL) return null;
    return token;
  }

  const refreshToken = readRefreshToken(connection);
  // Sentinel or null both mean we cannot refresh.
  if (!refreshToken || refreshToken === DECRYPT_ERROR_SENTINEL) return null;

  const result = await refreshAccessToken({
    clientId: cfg.clientId,
    clientSecret: cfg.clientSecret,
    refreshToken,
    fetchImpl: options.fetchImpl,
  });

  if (!result.ok) {
    // 401 / invalid_grant → token revocado.
    // Soft-disconnect: mark expired, owner re-authorizes via OAuth.
    // Preserves externalPosId for re-provision idempotency — hard delete
    // would force a fresh MP API roundtrip to re-create the POS.
    // Other errors (5xx, network) are transient — return null, let caller retry.
    if (result.status === 401 || isInvalidGrant(result.error)) {
      await prisma.mpConnection.update({
        where: { businessId },
        data: { expiresAt: new Date() },
      });
      cloudLog({
        severity: "ERROR",
        component: "System",
        action: "MP_TOKEN_REVOKED_AUTO",
        a2a_transfer: false,
        message: "MP refresh rejected — connection soft-disconnected (expiresAt=now). Owner must re-authorize.",
        data: { businessId, status: result.status, error: result.error },
      });
    }
    return null;
  }

  const tokens = result.tokens;
  const newExpiresAt = new Date(now + tokens.expires_in * 1000);
  await prisma.mpConnection.update({
    where: { businessId },
    data: {
      accessTokenCiphertext: encrypt(tokens.access_token),
      // MP may omit refresh_token on long-lived scopes — keep prior value when missing.
      refreshTokenCiphertext: tokens.refresh_token
        ? encrypt(tokens.refresh_token)
        : connection.refreshTokenCiphertext,
      publicKey: tokens.public_key ?? connection.publicKey,
      liveMode: tokens.live_mode ?? connection.liveMode,
      scope: tokens.scope ?? connection.scope,
      expiresAt: newExpiresAt,
    },
  });

  return tokens.access_token;
}

function isInvalidGrant(error: string): boolean {
  return /invalid[_\s-]?grant/i.test(error);
}

/**
 * Called by any MP API caller that receives a 401 response during normal use
 * (not during refresh). Marks the connection's expiresAt as now so subsequent
 * calls to getValidAccessToken() see an expired token immediately.
 *
 * Self-managed tokens (scope="self-managed") are long-lived per their design,
 * but MP can still revoke them. This function handles that case uniformly.
 *
 * Does NOT delete the connection — the owner must reconnect deliberately
 * (re-paste their token via /api/integrations/mp/connect-token or re-run OAuth).
 */
export async function markMpTokenRevoked(businessId: string): Promise<void> {
  try {
    await prisma.mpConnection.update({
      where: { businessId },
      data: { expiresAt: new Date() },
    });
    cloudLog({
      severity: "INFO",
      component: "System",
      action: "MP_TOKEN_REVOKED_DETECTED",
      a2a_transfer: false,
      message: "MP API returned 401 during use — marked token as expired in DB",
      data: { businessId },
    });
  } catch (err) {
    // Non-fatal: if the update fails (e.g. connection row was deleted concurrently),
    // log and continue. The next getValidAccessToken() call will return null anyway.
    cloudLog({
      severity: "WARNING",
      component: "System",
      action: "MP_TOKEN_REVOKE_MARK_FAILED",
      a2a_transfer: false,
      message: "markMpTokenRevoked: DB update failed",
      data: { businessId, error: err instanceof Error ? err.message : String(err) },
    });
  }
}
