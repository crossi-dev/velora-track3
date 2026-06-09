/**
 * Core logic for the MP connection health-check cron.
 *
 * Iterates every MpConnection whose expiresAt is still in the future
 * (i.e. not already marked expired), calls the MP /users/me endpoint to
 * verify the token is still accepted, and handles three outcomes:
 *
 *   200 → log INFO MP_HEALTH_CHECK_OK
 *   401 → mark expired (set expiresAt = now), log WARNING MP_HEALTH_CHECK_REVOKED,
 *          send WhatsApp to the owner's whatsappPhone
 *   other → log WARNING MP_HEALTH_CHECK_FAILED (transient; do NOT mark expired)
 *
 * Connections are processed with pLimit(5) — 5 concurrent (token-refresh + ping)
 * pairs instead of fully sequential. AbortSignal.timeout() caps each individual
 * HTTP call at FETCH_TIMEOUT_MS so a hung MP connection cannot block the pool.
 */

import pLimit from "p-limit";
import { prisma } from "@/lib/prisma";
import { cloudLog } from "@/lib/cloud-logger";
import { getValidAccessToken } from "@/app/api/integrations/mp/_lib/refresh-token";
import { sendWhatsAppMessage } from "@/lib/whatsapp";

const MP_USERS_ME = "https://api.mercadopago.com/users/me";
const FETCH_TIMEOUT_MS = 5_000;
// 5 concurrent slots: enough to parallelize multi-tenant runs without
// overwhelming MP rate limits or the Supabase pgbouncer connection pool.
const CONCURRENCY = 5;

const REVOKE_MESSAGE =
  "⚠️ Tu cuenta de Mercado Pago se desconectó de Velora. " +
  "Entrá a Servicios y reconectala así podés seguir cobrando.";

export interface HealthCheckResult {
  checked: number;
  ok: number;
  revoked: number;
  failed: number;
}

export async function runMpHealthCheck(
  fetchImpl: typeof fetch = fetch,
): Promise<HealthCheckResult> {
  const now = new Date();

  // Only check connections that haven't already been stamped as expired
  // (expiresAt <= now means we already know they're dead).
  const connections = await prisma.mpConnection.findMany({
    where: { expiresAt: { gt: now } },
    select: {
      businessId: true,
      business: { select: { whatsappPhone: true } },
    },
  });

  let ok = 0;
  let revoked = 0;
  let failed = 0;

  const limit = pLimit(CONCURRENCY);

  await Promise.all(
    connections.map((conn) =>
      limit(async () => {
        const { businessId } = conn;

        // getValidAccessToken handles refresh automatically; returns null if it
        // cannot obtain a live token (refresh failure is treated as a soft failure
        // here — the token may just be temporarily unreachable).
        const accessToken = await getValidAccessToken(businessId);

        if (!accessToken) {
          failed++;
          cloudLog({
            severity: "WARNING",
            component: "System",
            action: "MP_HEALTH_CHECK_FAILED",
            a2a_transfer: false,
            message: "mp-health-check: could not obtain access token — skipping ping",
            businessId,
            data: { reason: "getValidAccessToken_returned_null" },
          });
          return;
        }

        let status: number;
        try {
          const res = await fetchImpl(MP_USERS_ME, {
            headers: { Authorization: `Bearer ${accessToken}` },
            // AbortSignal.timeout() is the canonical Node 22+ pattern — no manual
            // AbortController needed. A hung MP connection cannot block the cron loop.
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          });
          status = res.status;
        } catch (err) {
          failed++;
          const isTimeout = err instanceof Error && err.name === "TimeoutError";
          cloudLog({
            severity: "WARNING",
            component: "System",
            action: "MP_HEALTH_CHECK_FAILED",
            a2a_transfer: false,
            message: isTimeout
              ? `mp-health-check: /users/me timed out after ${FETCH_TIMEOUT_MS}ms`
              : "mp-health-check: network error calling /users/me",
            businessId,
            data: { error: err instanceof Error ? err.message : String(err) },
          });
          return;
        }

        if (status === 200) {
          ok++;
          cloudLog({
            severity: "INFO",
            component: "System",
            action: "MP_HEALTH_CHECK_OK",
            a2a_transfer: false,
            message: "mp-health-check: connection is healthy",
            businessId,
          });
          return;
        }

        if (status === 401) {
          revoked++;
          await prisma.mpConnection.update({
            where: { businessId },
            data: { expiresAt: new Date() },
          });

          cloudLog({
            severity: "WARNING",
            component: "System",
            action: "MP_HEALTH_CHECK_REVOKED",
            a2a_transfer: false,
            message: "mp-health-check: 401 from /users/me — marked connection expired",
            businessId,
          });

          // Best-effort WhatsApp notification — failure must not abort the loop.
          const phone = conn.business.whatsappPhone;
          if (phone) {
            try {
              await sendWhatsAppMessage(phone, REVOKE_MESSAGE);
            } catch (err) {
              cloudLog({
                severity: "WARNING",
                component: "System",
                action: "MP_HEALTH_CHECK_WA_FAILED",
                a2a_transfer: false,
                message: "mp-health-check: WhatsApp notify failed (revoked)",
                businessId,
                data: { error: err instanceof Error ? err.message : String(err) },
              });
            }
          }
          return;
        }

        // Non-401, non-200: transient error — do not mark expired.
        failed++;
        cloudLog({
          severity: "WARNING",
          component: "System",
          action: "MP_HEALTH_CHECK_FAILED",
          a2a_transfer: false,
          message: `mp-health-check: unexpected status ${status} from /users/me`,
          businessId,
          data: { status },
        });
      }),
    ),
  );

  return { checked: connections.length, ok, revoked, failed };
}
