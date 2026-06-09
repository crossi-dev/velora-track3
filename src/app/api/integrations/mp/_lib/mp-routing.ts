// MP routing helper — resolves MP credentials per business.
//
// Multi-tenant path (default):
//   Queries MpConnection by businessId. If a row exists with a valid token,
//   returns decrypted credentials from DB (accessToken + mpUserId + externalPosId).
//
// Transitional env-vars fallback:
//   When no MpConnection row exists for the business, falls back to env vars
//   MP_DIRECT_ACCESS_TOKEN, MP_USER_ID, MP_EXTERNAL_POS_ID and logs a WARNING
//   (sentinel: MP_ROUTING_FALLBACK_TO_GLOBAL). This fallback exists for the
//   single-seller demo period. Remove once all businesses connect via OAuth.
//
// Never throws — returns null if no usable credentials found.
// Reads runtime (not module-load) to respect runtime feature flags.

import { prisma } from "@/lib/prisma";
import { decrypt } from "@/infrastructure/crypto/mp-token-cipher";
import { cloudLog } from "@/lib/cloud-logger";

export interface MpRouting {
  accessToken: string;
  mpUserId: string;
  externalPosId: string;
  source: "db" | "env";
}

function readEnvRouting(businessId: string): MpRouting | null {
  const accessToken = (process.env.MP_DIRECT_ACCESS_TOKEN ?? "").trim();
  const mpUserId = (process.env.MP_USER_ID ?? "").trim();
  const externalPosId = (process.env.MP_EXTERNAL_POS_ID ?? "").trim();
  if (!accessToken || !mpUserId || !externalPosId) return null;
  cloudLog({
    severity: "WARNING",
    component: "System",
    action: "MP_ROUTING_FALLBACK_TO_GLOBAL",
    a2a_transfer: false,
    message: "getMpRouting: no MpConnection found — falling back to global env vars",
    data: { businessId },
  });
  return { accessToken, mpUserId, externalPosId, source: "env" };
}

export async function getMpRouting(businessId: string): Promise<MpRouting | null> {
  try {
    const connection = await prisma.mpConnection.findUnique({
      where: { businessId },
      select: {
        accessTokenCiphertext: true,
        mpUserId: true,
        externalPosId: true,
        expiresAt: true,
      },
    });

    if (!connection) {
      return readEnvRouting(businessId);
    }

    if (!connection.accessTokenCiphertext) {
      cloudLog({
        severity: "ERROR",
        component: "System",
        action: "MP_TOKEN_MISSING_CIPHERTEXT",
        a2a_transfer: false,
        message: "getMpRouting: accessTokenCiphertext is null",
        data: { businessId },
      });
      return null;
    }

    let accessToken: string;
    try {
      accessToken = decrypt(connection.accessTokenCiphertext);
    } catch (decryptErr) {
      cloudLog({
        severity: "ERROR",
        component: "System",
        action: "MP_TOKEN_DECRYPT_ERROR",
        a2a_transfer: false,
        message: "getMpRouting: decrypt() failed — key may have rotated",
        data: {
          businessId,
          error: decryptErr instanceof Error ? decryptErr.message : String(decryptErr),
        },
      });
      return null;
    }

    if (!connection.mpUserId || !connection.externalPosId) {
      cloudLog({
        severity: "WARNING",
        component: "System",
        action: "MP_ROUTING_INCOMPLETE",
        a2a_transfer: false,
        message: "getMpRouting: MpConnection missing mpUserId or externalPosId",
        data: { businessId, hasMpUserId: !!connection.mpUserId, hasExternalPosId: !!connection.externalPosId },
      });
      return null;
    }

    return {
      accessToken,
      mpUserId: connection.mpUserId,
      externalPosId: connection.externalPosId,
      source: "db",
    };
  } catch (err) {
    cloudLog({
      severity: "ERROR",
      component: "System",
      action: "MP_ROUTING_DB_ERROR",
      a2a_transfer: false,
      message: "getMpRouting: DB query failed",
      data: { businessId, error: err instanceof Error ? err.message : String(err) },
    });
    return null;
  }
}

// Resolves only the access token. Useful for webhooks that need to call
// GET /merchant_orders/{id} but do not operate on a POS.
export async function getMpAccessToken(businessId: string | null): Promise<string | null> {
  if (businessId) {
    const routing = await getMpRouting(businessId);
    if (routing) return routing.accessToken;
  }
  // Fallback: env-only path for webhook calls without a known businessId.
  const envToken = (process.env.MP_DIRECT_ACCESS_TOKEN ?? "").trim();
  return envToken || null;
}
