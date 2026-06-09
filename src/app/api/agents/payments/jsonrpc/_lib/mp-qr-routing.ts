// QR in-store routing resolver — per-business MpConnection triple
// (accessToken + mpUserId + externalPosId).
//
// Split from mp-api-helpers.ts (file-size contract: 300-line hard limit).
// mp-api-helpers.ts handles Checkout Pro concerns (preference, status, token).
// This module handles QR in-store routing only.
//
// WS1-B: QR cobro charges into the SELLING BUSINESS's own MP account.
//   - accessToken + mpUserId come from MpConnection (already populated by OAuth).
//   - externalPosId is provisioned automatically at OAuth connect time via
//     ensureMpStorePosProvisioned (mp-pos-provisioning.ts). If that failed,
//     this function attempts LAZY provisioning on first QR use.
//
// LAZY PROVISIONING:
//   If a business is MP-connected but externalPosId is null (connected before
//   WS1-B, or provisioning failed at callback time), this function calls
//   ensureMpStorePosProvisioned inline. The QR cobro shows a "probá de nuevo"
//   message while provisioning runs; on the next attempt it succeeds.

import { cloudLog } from "@/lib/cloud-logger";
import { prisma } from "@/lib/prisma";
import { decrypt } from "@velora/core-utils/mp-token-cipher";
import { getMpConfig } from "@/app/api/integrations/mp/_lib/config";
import { getValidAccessToken } from "@/app/api/integrations/mp/_lib/refresh-token";
import { ensureMpStorePosProvisioned } from "@/app/api/integrations/mp/_lib/mp-pos-provisioning";
import {
  MP_TOKEN_NOT_CONNECTED,
  MP_TOKEN_EXPIRED,
  MP_TOKEN_DECRYPT_ERROR,
  MP_POS_NOT_CONFIGURED,
} from "./mp-api-helpers";

// Full routing triple needed for QR in-store cobro under the selling
// business's own MP account.
export interface MpBusinessRouting {
  accessToken: string;
  mpUserId: string;
  externalPosId: string;
}

export type MpRoutingResult =
  | MpBusinessRouting
  | typeof MP_TOKEN_NOT_CONNECTED
  | typeof MP_TOKEN_EXPIRED
  | typeof MP_TOKEN_DECRYPT_ERROR
  | typeof MP_POS_NOT_CONFIGURED
  | null; // null = unexpected DB/infra error

// Resolves the full QR routing triple from a business's MpConnection row.
// Returns a typed sentinel when any piece is missing so callers can surface
// precise, user-facing Spanish error messages without catching exceptions.
//
// Token refresh: mirrors getMpTokenForBusiness — OAuth-scoped connections attempt
// silent refresh via getValidAccessToken when MP_CLIENT_ID/SECRET are configured.
// Self-managed connections return MP_TOKEN_EXPIRED immediately (no refresh key).
export async function getMpRoutingForBusiness(
  businessId: string,
): Promise<MpRoutingResult> {
  if (!businessId) return null;

  try {
    const connection = await prisma.mpConnection.findUnique({
      where: { businessId },
      select: {
        accessTokenCiphertext: true,
        expiresAt: true,
        mpUserId: true,
        externalPosId: true,
        scope: true,
      },
    });

    if (!connection) return MP_TOKEN_NOT_CONNECTED;

    if (connection.expiresAt < new Date()) {
      if (connection.scope !== "self-managed") {
        // OAuth-scoped token — attempt silent refresh when credentials are configured.
        // Mirrors the Checkout Pro path in getMpTokenForBusiness (mp-api-helpers.ts).
        const cfg = getMpConfig();
        if (cfg.isConfigured) {
          cloudLog({
            severity: "INFO",
            component: "System",
            action: "MP_QR_TOKEN_AUTO_REFRESH_ATTEMPT",
            a2a_transfer: false,
            message: "getMpRoutingForBusiness: token expirado — intentando auto-refresh",
            data: { businessId, expiresAt: connection.expiresAt.toISOString() },
          });
          const refreshed = await getValidAccessToken(businessId);
          if (refreshed) {
            // Re-read the QR-specific fields (mpUserId, externalPosId) from DB
            // now that the token row has been updated by getValidAccessToken.
            const updated = await prisma.mpConnection.findUnique({
              where: { businessId },
              select: { mpUserId: true, externalPosId: true },
            });
            if (updated?.mpUserId && updated.externalPosId) {
              return { accessToken: refreshed, mpUserId: updated.mpUserId, externalPosId: updated.externalPosId };
            }
            // Row gone after refresh (revoked) — fall through to MP_TOKEN_NOT_CONNECTED.
            const still = await prisma.mpConnection.findUnique({ where: { businessId }, select: { id: true } });
            if (!still) return MP_TOKEN_NOT_CONNECTED;
          }
        } else {
          cloudLog({
            severity: "WARNING",
            component: "System",
            action: "MP_QR_TOKEN_EXPIRED",
            a2a_transfer: false,
            message: "getMpRoutingForBusiness: token expirado — requiere reconexión OAuth (refresh no configurado)",
            data: { businessId, expiresAt: connection.expiresAt.toISOString() },
          });
        }
      } else {
        cloudLog({
          severity: "WARNING",
          component: "System",
          action: "MP_ROUTING_TOKEN_EXPIRED",
          a2a_transfer: false,
          message: "getMpRoutingForBusiness: self-managed token expirado — dueño debe pegar uno nuevo",
          data: { businessId, expiresAt: connection.expiresAt.toISOString() },
        });
      }
      return MP_TOKEN_EXPIRED;
    }

    let accessToken: string;
    if (connection.accessTokenCiphertext) {
      try {
        accessToken = decrypt(connection.accessTokenCiphertext);
      } catch (decryptErr) {
        cloudLog({
          severity: "WARNING",
          component: "System",
          action: "MP_ROUTING_DECRYPT_ERROR",
          a2a_transfer: false,
          message: "getMpRoutingForBusiness: decrypt() falló",
          data: {
            businessId,
            error: decryptErr instanceof Error ? decryptErr.message : String(decryptErr),
          },
        });
        return MP_TOKEN_DECRYPT_ERROR;
      }
    } else {
      // No ciphertext — connection row has no token after plaintext columns drop.
      cloudLog({
        severity: "ERROR",
        component: "System",
        action: "MP_TOKEN_MISSING_CIPHERTEXT",
        a2a_transfer: false,
        message: "getMpRoutingForBusiness: accessTokenCiphertext is null — token unavailable",
        data: { businessId },
      });
      return MP_TOKEN_DECRYPT_ERROR;
    }

    // externalPosId is normally set at OAuth connect time via auto-provisioning.
    // If null (connected before WS1-B, or provisioning failed at callback),
    // attempt LAZY provisioning now — fire inline so the next call after a brief
    // retry succeeds. Return MP_POS_NOT_CONFIGURED so the caller surfaces the
    // "Estamos configurando tu QR, probá de nuevo en un momento." message.
    if (!connection.externalPosId) {
      // Fire lazy provisioning without awaiting — the current QR attempt will
      // show a "retry in a moment" message; the next attempt will find the
      // externalPosId in DB once provisioning completes.
      void ensureMpStorePosProvisioned({
        businessId,
        accessToken,
        mpUserId: connection.mpUserId,
      }).then((result) => {
        if (!result.ok) {
          cloudLog({
            severity: "WARNING",
            component: "System",
            action: "MP_LAZY_PROVISION_FAILED",
            a2a_transfer: false,
            message: "Lazy POS provisioning failed — will retry on next QR attempt",
            data: { businessId, reason: result.reason },
          });
        }
      });
      return MP_POS_NOT_CONFIGURED;
    }

    return {
      accessToken,
      mpUserId: connection.mpUserId,
      externalPosId: connection.externalPosId,
    };
  } catch (err) {
    cloudLog({
      severity: "ERROR",
      component: "System",
      action: "MP_ROUTING_RESOLUTION_ERROR",
      a2a_transfer: false,
      message: "getMpRoutingForBusiness: error resolviendo routing",
      data: {
        businessId,
        error: err instanceof Error ? err.message : String(err),
      },
    });
    return null;
  }
}
